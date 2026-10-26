/**
 * Calendar feed sync, stage C4: telling people when the club's calendar changes things.
 *
 * - "Cancelled or moved" (families, and staff who aren't parents): when a sync cancels something in
 *   the next two weeks, or changes its day, time, place or court. One email per sync with every such
 *   change, so a sync that changes nothing sends nothing. Changes that only come from new rules, from
 *   a renamed title, or to a field the team overrode aren't sent.
 * - "Calendar feed alerts" (team admins and coordinators): new things to review, a feed paused because
 *   its rules stopped matching, or one that couldn't be read for a few hours. Once per occurrence.
 *
 * Both are held overnight (9 PM to 7 AM in the team's time zone; for families the team can turn that
 * off) as FEEDLOG#t / NOTICE#… rows, and the feed job sends them in the morning.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { keys } from "../keys.js";
import { clubSendsEmail } from "../club-controls.js";
import { deleteMany, putItem, queryAll } from "../../api/util.js";
import { effective, type TeamComms } from "../../shared/messages.js";
import type { ChangeItem } from "../mail/feed-mail.js";
import { has, loadTeam, type Member, type Team } from "./content.js";
import { common, optedOut, queueAll } from "./events.js";
import { getComms, zoneOf } from "./planner.js";
import { audienceFor } from "./reminders.js";
import { shortDate } from "./schedule.js";
import { localParts } from "./zoned.js";

/** One event the calendar changed in a way families should hear about. */
export type FeedNotice = {
  eid: string; title: string;
  /** Its date now, and before when it moved. */
  date: string; wasDate?: string;
  text: string; cancelled: boolean;
  /** What changed: cancelled, date, time, endTime, location, court. */
  fields: string[];
  time?: string; endTime?: string; location?: string; court?: string;
};
export type FeedAlert = { kind: "review" | "attention" | "failing"; items: string[]; detail?: string };

/** The fields a change has to touch for families to hear about it. */
export const NOTICE_FIELDS = ["cancelled", "date", "time", "endTime", "location", "court"] as const;
const WINDOW_DAYS = 14;
const QUIET = { from: 21, to: 7 };

const addDay = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isQuiet = (zone: string) => { const h = Number(localParts(new Date(), zone).hhmm.slice(0, 2)); return h >= QUIET.from || h < QUIET.to; };

/** Team admins and coordinators who take calendar feed alerts. */
export function feedAlertAudience(t: Team, audience: Record<string, boolean>): Member[] {
  return t.members.filter((m) => !optedOut(m, "feedAlert") && ((audience.admin && m.roles.includes("admin")) || (audience.coordinator && m.roles.includes("coordinator"))));
}

async function hold(teamId: string, key: string, row: Record<string, unknown>) {
  await putItem({ ...keys.feedLog(teamId, `NOTICE#${new Date().toISOString()}#${key}`), type: "FeedNotice", key, ...row, ttl: Math.floor(Date.now() / 1000) + 3 * 86400 });
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.feedSource(teamId), UpdateExpression: "SET noticesHeld = :t", ConditionExpression: "attribute_exists(PK)", ExpressionAttributeValues: { ":t": true } })).catch(() => undefined);
}

const item = (n: FeedNotice): ChangeItem => ({
  date: shortDate(n.date), title: n.title, text: n.text, cancelled: n.cancelled,
  when: n.time ? `${n.time}${n.endTime ? ` – ${n.endTime}` : ""}` : undefined,
  place: [n.location, n.court].filter(Boolean).join(" · ") || undefined
});

export type NoticeResult = { emailed: number; held: boolean; reason?: "off" | "club" | "feature" | "paused" | "none" };

/** Emails families about calendar changes coming up soon. `key` makes it once-only (the sync run). */
export async function notifyChanges(teamId: string, clubId: string, notices: FeedNotice[], key: string, opt: { now?: boolean } = {}): Promise<NoticeResult> {
  const c = await getComms(teamId);
  const e = effective("change", c)!;
  if (!e.on) return { emailed: 0, held: false, reason: "off" };
  const zone = zoneOf(c);
  const today = localParts(new Date(), zone).date;
  const last = addDay(today, WINDOW_DAYS);
  const soon = (d?: string) => !!d && d >= today && d <= last;
  const list = notices.filter((n) => (soon(n.date) || soon(n.wasDate)) && (e.rules.court || n.fields.some((f) => f !== "court")));
  if (!list.length) return { emailed: 0, held: false, reason: "none" };
  if (c?.pauseUntil && today <= c.pauseUntil) return { emailed: 0, held: false, reason: "paused" };
  if (!(await clubSendsEmail(clubId))) return { emailed: 0, held: false, reason: "club" };
  if (!opt.now && e.rules.overnight && isQuiet(zone)) { await hold(teamId, key, { kind: "change", notices: list }); return { emailed: 0, held: true }; }
  const t = await loadTeam(teamId, clubId);
  if (!has(t, "calfeed")) return { emailed: 0, held: false, reason: "feature" };
  const data = { ...common(t, c, "change"), source: t.club?.short || "the club", changes: list.sort((a, b) => a.date.localeCompare(b.date)).map(item) };
  const people = audienceFor(t, "change", e.audience).map((m) => ({ m, data: { ...data, firstName: m.firstName } }));
  return { emailed: await queueAll(t, "change", people, `change:${key}`), held: false };
}

/** Emails a team's admins and coordinators about the feed. `key` makes it once per occurrence. */
export async function alertAdmins(teamId: string, clubId: string, a: FeedAlert, key: string, opt: { now?: boolean } = {}): Promise<NoticeResult> {
  const c = await getComms(teamId);
  const e = effective("feedAlert", c)!;
  if (!e.on) return { emailed: 0, held: false, reason: "off" };
  if (!(await clubSendsEmail(clubId))) return { emailed: 0, held: false, reason: "club" };
  if (!opt.now && isQuiet(zoneOf(c))) { await hold(teamId, key, { kind: "alert", alert: a }); return { emailed: 0, held: true }; }
  const t = await loadTeam(teamId, clubId);
  if (!has(t, "calfeed")) return { emailed: 0, held: false, reason: "feature" };
  const data = { ...common(t, c, "feedAlert"), source: t.club?.short || "the club", ...a, items: a.items.slice(0, 20) };
  const people = feedAlertAudience(t, e.audience).map((m) => ({ m, data: { ...data, firstName: m.firstName } }));
  return { emailed: await queueAll(t, "feedAlert", people, `feedAlert:${key}`), held: false };
}

/** Sends what was held overnight, once it's morning where the team is. Changes go as one email. */
export async function flushHeld(teamId: string, clubId: string, c?: TeamComms | null): Promise<number> {
  const comms = c ?? (await getComms(teamId));
  if (isQuiet(zoneOf(comms))) return 0;
  const rows = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `FEEDLOG#${teamId}`, ":s": "NOTICE#" } });
  let sent = 0;
  const changes = rows.filter((r) => r.kind === "change");
  if (changes.length) {
    // The latest change to each event wins.
    const byEvent = new Map<string, FeedNotice>();
    for (const r of changes) for (const n of r.notices as FeedNotice[]) byEvent.set(n.eid, n);
    sent += (await notifyChanges(teamId, clubId, [...byEvent.values()], `held:${changes.map((r) => r.key).join(",")}`.slice(0, 400), { now: true })).emailed;
  }
  for (const r of rows.filter((x) => x.kind === "alert")) sent += (await alertAdmins(teamId, clubId, r.alert as FeedAlert, String(r.key), { now: true })).emailed;
  await deleteMany(rows.map((r) => ({ PK: String(r.PK), SK: String(r.SK) })));
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.feedSource(teamId), UpdateExpression: "REMOVE noticesHeld", ConditionExpression: "attribute_exists(PK)" })).catch(() => undefined);
  if (rows.length) console.log(JSON.stringify({ msg: "feed notices sent after the night", teamId, held: rows.length, emailed: sent }));
  return sent;
}
