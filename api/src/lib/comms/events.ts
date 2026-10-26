/**
 * Messaging M2b: emails sent when something happens. Finance records a payment or approves a
 * reimbursement ("Payment recorded"), or someone posting ticks "Also email the team" (announcement
 * emails). Each is off until the team turns it on, and each delivery's dedupe key names what it's
 * about, so recording the same payment twice sends one email.
 */
import { clubSendsEmail } from "../club-controls.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { keys } from "../keys.js";
import { getItem } from "../../api/util.js";
import { effective, type TeamComms } from "../../shared/messages.js";
import { siteUrl } from "../mail/invite-mail.js";
import { dispatch, queueEmail } from "../mail/outbox.js";
import { duesOwed, has, isStaff, loadTeam, money, str, type Member, type Team } from "./content.js";
import { emailOf, getComms, scheduleText, unsubHeaders, zoneOf } from "./planner.js";
import { shortDate } from "./schedule.js";
import { signUnsub } from "./tokens.js";
import { localParts } from "./zoned.js";

export const optedOut = (m: Member, msg: string) => m.notifyOff.includes(msg) || m.notifyOff.includes("all");

async function personName(sub: string): Promise<string> {
  const p = await getItem(keys.profile(sub));
  return [p?.firstName, p?.lastName].filter((x) => typeof x === "string" && x).join(" ");
}

export function common(t: Team, c: TeamComms | null, msg: "payment" | "announcement" | "change" | "feedAlert") {
  return { teamName: t.teamName, teamId: t.teamId, clubName: t.club?.name, colors: t.club?.colors, siteUrl: siteUrl(), schedule: scheduleText(msg, c) };
}

export async function queueAll(t: Team, msg: "payment" | "announcement" | "change" | "feedAlert", people: { m: Member; data: Record<string, unknown> }[], key: string): Promise<number> {
  const ids: string[] = [];
  for (const { m, data } of people) {
    const to = await emailOf(m);
    if (!to) continue;
    const unsubscribeUrl = `${siteUrl()}/unsubscribe#t=${await signUnsub({ sub: m.sub, teamId: t.teamId, msg })}`;
    const { id, queued } = await queueEmail({
      msg, to, teamId: t.teamId, clubId: t.clubId, data: { ...data, unsubscribeUrl } as never,
      dedupe: `${key}:${t.teamId}:${m.sub}`, headers: await unsubHeaders(m, t.teamId, msg)
    });
    if (queued) ids.push(id);
  }
  await dispatch(ids);
  return ids.length;
}

export type LedgerEntry = { lid: string; kind: string; cat: string; pid?: string; payee?: string; amountCents: number; date: string; desc: string };

/** A payment recorded for a family, or a reimbursement approved for whoever asked. */
export async function notifyPayment(teamId: string, clubId: string, l: LedgerEntry, by: string): Promise<number> {
  const c = await getComms(teamId);
  const e = effective("payment", c)!;
  if (!e.on || !(await clubSendsEmail(clubId))) return 0;
  const t = await loadTeam(teamId, clubId);
  if (!has(t, "fund")) return 0;
  const recordedBy = await personName(by);
  const base = { ...common(t, c, "payment"), amount: money(Number(l.amountCents)), what: l.desc || l.cat, date: shortDate(l.date), recordedBy };
  const people: { m: Member; data: Record<string, unknown> }[] = [];
  if (l.kind === "in" && l.pid && e.audience.parent) {
    const player = t.players.find((p) => p.pid === l.pid);
    const owed = l.cat === "Dues" && Number((t.settings.dues as Record<string, unknown> | undefined)?.amountCents) ? duesOwed(t, l.pid) : null;
    for (const m of t.members.filter((x) => x.roles.includes("parent") && x.pid === l.pid && !optedOut(x, "payment"))) {
      people.push({ m, data: { ...base, firstName: m.firstName, kind: "in", playerFirst: str(player?.first), duesLeft: owed === null ? undefined : money(owed) } });
    }
  }
  if (l.kind === "out" && l.payee && e.audience.reimb) {
    const m = t.members.find((x) => x.sub === l.payee && !optedOut(x, "payment"));
    if (m) people.push({ m, data: { ...base, firstName: m.firstName, kind: "out" } });
  }
  return queueAll(t, "payment", people, `payment:${l.lid}`);
}

export type AnnouncementResult = { emailed: number; reason?: "off" | "cap" | "already" | "club" };

/** Emails a post to the team. At most two a week when the team keeps the cap on. */
export async function notifyAnnouncement(teamId: string, clubId: string, aid: string, by: string): Promise<AnnouncementResult> {
  const c = await getComms(teamId);
  const e = effective("announcement", c)!;
  if (!e.on) return { emailed: 0, reason: "off" };
  if (!(await clubSendsEmail(clubId))) return { emailed: 0, reason: "club" };
  const ann = await getItem(keys.announcement(teamId, aid));
  if (!ann) return { emailed: 0 };
  if (ann.emailedAt) return { emailed: 0, reason: "already" };
  if (e.rules.cap) {
    // Weeks run Sunday to Saturday in the team's time zone.
    const today = localParts(new Date(), zoneOf(c));
    const sunday = new Date(Date.parse(`${today.date}T12:00:00Z`) - today.dow * 86400_000).toISOString().slice(0, 10);
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: { PK: `RUN#${teamId}`, SK: `announcement-week#${sunday}` },
        UpdateExpression: "ADD n :one SET #ttl = :ttl", ConditionExpression: "attribute_not_exists(n) OR n < :cap",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":cap": 2, ":ttl": Math.floor(Date.now() / 1000) + 14 * 86400 }
      }));
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") return { emailed: 0, reason: "cap" };
      throw err;
    }
  }
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.announcement(teamId, aid), UpdateExpression: "SET emailedAt = :a, emailedBy = :b", ExpressionAttributeValues: { ":a": new Date().toISOString(), ":b": by } }));
  const t = await loadTeam(teamId, clubId);
  const author = (await personName(by)) || "Your coach";
  const posted = shortDate(localParts(new Date(String(ann.at ?? new Date().toISOString())), zoneOf(c)).date);
  const data = { ...common(t, c, "announcement"), author, text: str(ann.text), posted, pinned: !!ann.pinned };
  const people = t.members
    .filter((m) => m.sub !== by && !optedOut(m, "announcement"))
    .filter((m) => (m.roles.includes("parent") && e.audience.parent) || (isStaff(m) && e.audience.staff))
    .map((m) => ({ m, data }));
  return { emailed: await queueAll(t, "announcement", people, `announcement:${aid}`) };
}
