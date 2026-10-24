/**
 * The planner (Messaging M2): every 15 minutes it finds scheduled messages that are due on each team,
 * in the team's time zone, and queues one email per person. The same code, run as a dry run, fills
 * the Communications page's Upcoming tab, so what admins see is what goes out.
 *
 * Two kinds of scheduled message: weekly ones (the weekly at-a-glance, the staff digest) and ones sent a
 * number of days before something (a tournament's packet, an availability reminder, a dues reminder).
 *
 * Each send happens once: a run marker (RUN#<team>/<msg>#<what>) is written before anything is queued,
 * and every delivery's dedupe key names the team, the send and the person.
 */
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { keys } from "../keys.js";
import { queryAll } from "../../api/util.js";
import { CONFIG, DAY_NAMES, DEFAULT_TIME_ZONE, effective, NEEDS_FEATURE, timeLabel, type MessageId, type TeamComms } from "../../shared/messages.js";
import { dispatch, queueEmail } from "../mail/outbox.js";
import { siteUrl } from "../mail/invite-mail.js";
import type { MailData } from "../mail/templates.js";
import { has, loadTeam, recipients, staffContent, staffIsEmpty, weeklyContent, weeklyIsEmpty, type Member, type Team } from "./content.js";
import { audienceFor, availabilityContent, duesContent, packetContent, targets, type ReminderMsg, type Target } from "./reminders.js";
import { signUnsub } from "./tokens.js";
import { localParts, nextDays, validTimeZone, weekday, zonedInstant } from "./zoned.js";

export const WEEKLY: ("weekly" | "staffDigest")[] = ["weekly", "staffDigest"];
export const REMINDERS: ReminderMsg[] = ["packet", "availability", "dues"];
export const SCHEDULED = [...WEEKLY, ...REMINDERS];
export type Planned = (typeof SCHEDULED)[number];
/** Messages a team sets up on the Communications page, in the order they're shown. */
export const SETTABLE: MessageId[] = [...SCHEDULED, "payment", "announcement"];

/** A send that's this late (the planner was down) still goes; later than that, it's skipped. */
export const CATCH_UP_MS = 3 * 3600_000;
const RUN_DAYS = 30;

export const commsKey = (teamId: string) => ({ PK: `TEAM#${teamId}`, SK: "META#COMMS" });
export async function getComms(teamId: string): Promise<TeamComms | null> {
  return ((await ddb.send(new GetCommand({ TableName: TABLE, Key: commsKey(teamId) }))).Item as TeamComms | undefined) ?? null;
}

export const zoneOf = (c: TeamComms | null) => (c?.timeZone && validTimeZone(c.timeZone) ? c.timeZone : DEFAULT_TIME_ZONE);

export type Occurrence = { msg: Planned; date: string; sendAt: Date; key: string; label: string; skipped: boolean; paused: boolean; target?: Target };

/** A message is sent only when it's on, and the feature it needs (the team fund for dues) is on too. */
export const sends = (msg: MessageId, c: TeamComms | null, t?: Team | null) => {
  const e = effective(msg, c);
  if (!e?.on) return false;
  const f = NEEDS_FEATURE[msg];
  return !f || !t || has(t, f);
};

/** Every scheduled send from today (team time) for `days` days. Reminders need the team's records. */
export function occurrences(c: TeamComms | null, now: Date, days: number, t: Team | null = null): Occurrence[] {
  const tz = zoneOf(c);
  const dates = nextDays(localParts(now, tz).date, days);
  const first = dates[0], last = dates[dates.length - 1];
  const out: Occurrence[] = [];
  const mark = (key: string, date: string) => ({ skipped: !!c?.skipped?.includes(key), paused: !!c?.pauseUntil && date <= c.pauseUntil });
  for (const msg of WEEKLY) {
    const e = effective(msg, c)!;
    if (!e.on) continue;
    for (const date of dates) {
      if (weekday(date) !== e.day) continue;
      const key = `${msg}:${date}`;
      out.push({ msg, date, sendAt: zonedInstant(date, e.time, tz), key, label: CONFIG_LABEL[msg], ...mark(key, date) });
    }
  }
  if (t) {
    for (const msg of REMINDERS) {
      if (!sends(msg, c, t)) continue;
      const e = effective(msg, c)!;
      for (const target of targets(t, msg, e)) {
        if (target.sendDate < first || target.sendDate > last) continue;
        out.push({ msg, date: target.sendDate, sendAt: zonedInstant(target.sendDate, e.time, tz), key: target.key, label: target.label, target, ...mark(target.key, target.sendDate) });
      }
    }
  }
  return out.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime() || a.key.localeCompare(b.key));
}
const CONFIG_LABEL: Record<string, string> = { weekly: "Weekly at-a-glance", staffDigest: "Staff digest" };

/** Sends due now: their time has passed, by less than CATCH_UP_MS. */
export function dueNow(c: TeamComms | null, now: Date, t: Team | null = null): Occurrence[] {
  // Yesterday too, for a send just before midnight that the planner reaches just after.
  const start = new Date(now.getTime() - 86400_000);
  return occurrences(c, start, 3, t).filter((o) => o.sendAt <= now && now.getTime() - o.sendAt.getTime() < CATCH_UP_MS && !o.skipped && !o.paused);
}

export function scheduleText(msg: MessageId, c: TeamComms | null): string {
  const e = effective(msg, c);
  const timing = CONFIG[msg]?.timing;
  if (!e || !timing) return "";
  if (timing.kind === "weekly") return `on ${DAY_NAMES[e.day]}s at ${timeLabel(e.time)}`;
  if (timing.kind === "before") return `${e.days} day${e.days === 1 ? "" : "s"} before ${timing.what}, at ${timeLabel(e.time)}`;
  return timing.when.replace(/\.$/, "").toLowerCase();
}

/** For staff digests: only the roles the team chose to include. */
const forAudience = (m: Member, msg: Planned, audience: Record<string, boolean>): Member =>
  (msg === "staffDigest" ? { ...m, roles: m.roles.filter((r) => audience[r]) } : m);

export type Prepared = { member: Member; data: MailData[Planned]; empty: boolean };

/** Builds each person's email for one send (nothing is queued). `only` limits it to stand-in recipients (previews). */
export async function prepare(t: Team, c: TeamComms | null, o: Pick<Occurrence, "msg" | "date" | "target">, only?: Member[]): Promise<Prepared[]> {
  const msg = o.msg;
  const e = effective(msg, c)!;
  const site = siteUrl();
  const common = { teamName: t.teamName, teamId: t.teamId, clubName: t.club?.name, colors: t.club?.colors, siteUrl: site, schedule: scheduleText(msg, c) };
  let people: Member[];
  if (only) people = only;
  else if (msg === "weekly" || msg === "staffDigest") people = recipients(t, msg, e.audience);
  else if (msg === "packet") people = audienceFor(t, msg, e.audience);
  else people = audienceFor(t, msg, { parent: e.audience.parent });
  const out: Prepared[] = [];
  for (const m0 of people) {
    const m = forAudience(m0, msg, e.audience);
    const unsubscribeUrl = `${site}/unsubscribe#t=${await signUnsub({ sub: m.sub, teamId: t.teamId, msg })}`;
    const base = { ...common, firstName: m.firstName, unsubscribeUrl };
    if (msg === "weekly") {
      const content = weeklyContent(t, m, o.date);
      out.push({ member: m, empty: weeklyIsEmpty(content), data: { ...base, hideEmpty: e.rules.hideEmpty, content } });
    } else if (msg === "staffDigest") {
      const content = staffContent(t, m, o.date);
      out.push({ member: m, empty: staffIsEmpty(content), data: { ...base, content } });
    } else if (msg === "packet") {
      const content = packetContent(t, m, o.target?.eid ?? "");
      if (content) out.push({ member: m, empty: false, data: { ...base, content } });
    } else if (msg === "availability") {
      const content = await availabilityContent(t, m, o.target?.itemKeys ?? [], site);
      out.push({ member: m, empty: !content.items.length, data: { ...base, content } });
    } else {
      const content = o.target?.due ? duesContent(t, m, o.target.due, !!o.target.late) : null;
      if (content) out.push({ member: m, empty: false, data: { ...base, content } });
    }
  }
  return out;
}

/** The one-click unsubscribe headers Gmail and Yahoo ask bulk senders for (RFC 8058). */
export async function unsubHeaders(m: Member, teamId: string, msg: string): Promise<Record<string, string> | undefined> {
  const api = (process.env.API_URL || "").replace(/\/$/, "");
  if (!api) return undefined;
  const token = await signUnsub({ sub: m.sub, teamId, msg });
  return { "List-Unsubscribe": `<${api}/public/unsubscribe?t=${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

export async function emailOf(m: Member): Promise<string> {
  return m.email || String((await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.profile(m.sub) }))).Item?.email ?? "");
}

const runKey = (key: string) => key.replace(":", "#");

/** Did the weekly email go out on this team in the two days before `date` (and asked them already)? */
async function weeklyJustSent(teamId: string, date: string): Promise<boolean> {
  for (const d of [date, ...[1, 2].map((n) => new Date(Date.parse(`${date}T12:00:00Z`) - n * 86400_000).toISOString().slice(0, 10))]) {
    const got = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `RUN#${teamId}`, SK: `weekly#${d}` } }));
    if (got.Item) return true;
  }
  return false;
}

/** Queues one send on a team. Returns how many emails were queued and how many were skipped as empty. */
export async function send(teamId: string, clubId: string, o: Pick<Occurrence, "msg" | "date" | "key" | "target">, c: TeamComms | null, team?: Team): Promise<{ queued: number; empty: number }> {
  const e = effective(o.msg, c)!;
  const t = team ?? (await loadTeam(teamId, clubId));
  if (o.msg === "availability" && e.rules.skipIfWeekly && effective("weekly", c)!.on && (await weeklyJustSent(teamId, o.date))) return { queued: 0, empty: 0 };
  const prepared = await prepare(t, c, o);
  const ids: string[] = [];
  let empty = 0;
  for (const p of prepared) {
    if (p.empty && (o.msg === "availability" || e.rules.skipEmpty)) { empty++; continue; }
    const to = await emailOf(p.member);
    if (!to) continue;
    const { id, queued } = await queueEmail({
      msg: o.msg, to, teamId, clubId, data: p.data as never,
      dedupe: `${o.key}:${teamId}:${p.member.sub}`,
      headers: await unsubHeaders(p.member, teamId, o.msg)
    });
    if (queued) ids.push(id);
  }
  await dispatch(ids);
  return { queued: ids.length, empty };
}

/** Claims a send so it runs once, however many planner runs see it. */
export async function claim(teamId: string, key: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)",
      Item: { PK: `RUN#${teamId}`, SK: key, type: "CommsRun", at: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + RUN_DAYS * 86400, ...extra }
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** One planner run across every active team that has messages set up. */
export async function runPlanner(now = new Date()): Promise<{ teams: number; sends: { teamId: string; key: string; queued: number; empty: number }[] }> {
  const clubs = (await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": "CLUBS" } })).map((c) => String(c.SK).slice(5));
  const out: { teamId: string; key: string; queued: number; empty: number }[] = [];
  let teams = 0;
  for (const clubId of clubs) {
    const dirs = await queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" } });
    for (const d of dirs.filter((x) => !x.archived)) {
      const teamId = String(d.SK).slice(5);
      const c = await getComms(teamId);
      if (!c) continue; // nothing turned on
      teams++;
      // Reminders depend on the team's schedule; read it only for teams that have one on.
      const t = REMINDERS.some((m) => effective(m, c)!.on) ? await loadTeam(teamId, clubId) : null;
      for (const o of dueNow(c, now, t)) {
        if (!(await claim(teamId, runKey(o.key)))) continue;
        try {
          out.push({ teamId, key: o.key, ...(await send(teamId, clubId, o, c, t ?? undefined)) });
        } catch (err) {
          console.error(JSON.stringify({ msg: "planner send failed", teamId, key: o.key, error: String(err) }));
          // Let the next run try again; emails already queued aren't queued twice.
          await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RUN#${teamId}`, SK: runKey(o.key) } })).catch(() => {});
        }
      }
    }
  }
  return { teams, sends: out };
}

export { CONFIG };
