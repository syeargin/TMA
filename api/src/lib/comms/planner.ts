/**
 * The planner (Messaging M2): every 15 minutes it finds scheduled messages that are due on each team,
 * in the team's time zone, and queues one email per person. The same code, run as a dry run, fills
 * the Communications page's Upcoming tab, so what admins see is what goes out.
 *
 * Each send happens once: a run marker (RUN#<team>/<msg>#<date>) is written before anything is queued,
 * and every delivery's dedupe key names the team, message, date and person.
 */
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { keys } from "../keys.js";
import { queryAll } from "../../api/util.js";
import { DAY_NAMES, DEFAULT_TIME_ZONE, effective, timeLabel, type MessageId, type TeamComms } from "../../shared/messages.js";
import { dispatch, queueEmail } from "../mail/outbox.js";
import { siteUrl } from "../mail/invite-mail.js";
import type { StaffData, WeeklyData } from "../mail/digests.js";
import { loadTeam, recipients, staffContent, staffIsEmpty, weeklyContent, weeklyIsEmpty, type Member, type Team } from "./content.js";
import { signUnsub } from "./tokens.js";
import { localParts, nextDays, validTimeZone, weekday, zonedInstant } from "./zoned.js";

export const SCHEDULED: ("weekly" | "staffDigest")[] = ["weekly", "staffDigest"];
/** A send that's this late (the planner was down) still goes; later than that, it's skipped. */
export const CATCH_UP_MS = 3 * 3600_000;
const RUN_DAYS = 30;

export const commsKey = (teamId: string) => ({ PK: `TEAM#${teamId}`, SK: "META#COMMS" });
export async function getComms(teamId: string): Promise<TeamComms | null> {
  return ((await ddb.send(new GetCommand({ TableName: TABLE, Key: commsKey(teamId) }))).Item as TeamComms | undefined) ?? null;
}

export const zoneOf = (c: TeamComms | null) => (c?.timeZone && validTimeZone(c.timeZone) ? c.timeZone : DEFAULT_TIME_ZONE);

export type Occurrence = { msg: "weekly" | "staffDigest"; date: string; sendAt: Date; key: string; skipped: boolean; paused: boolean };

/** Every scheduled send from today (team time) for `days` days. */
export function occurrences(c: TeamComms | null, now: Date, days: number): Occurrence[] {
  const tz = zoneOf(c);
  const today = localParts(now, tz).date;
  const out: Occurrence[] = [];
  for (const msg of SCHEDULED) {
    const e = effective(msg, c)!;
    if (!e.on) continue;
    for (const date of nextDays(today, days)) {
      if (weekday(date) !== e.day) continue;
      const key = `${msg}:${date}`;
      out.push({ msg, date, sendAt: zonedInstant(date, e.time, tz), key, skipped: !!c?.skipped?.includes(key), paused: !!c?.pauseUntil && date <= c.pauseUntil });
    }
  }
  return out.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}

/** Sends due now: their time has passed, by less than CATCH_UP_MS. */
export function dueNow(c: TeamComms | null, now: Date): Occurrence[] {
  // Yesterday too, for a send just before midnight that the planner reaches just after.
  const start = new Date(now.getTime() - 86400_000);
  return occurrences(c, start, 3).filter((o) => o.sendAt <= now && now.getTime() - o.sendAt.getTime() < CATCH_UP_MS && !o.skipped && !o.paused);
}

export const scheduleText = (msg: MessageId, c: TeamComms | null) => {
  const e = effective(msg, c);
  return e ? `on ${DAY_NAMES[e.day]}s at ${timeLabel(e.time)}` : "";
};

/** For staff digests: only the roles the team chose to include. */
function forAudience(m: Member, msg: "weekly" | "staffDigest", audience: Record<string, boolean>): Member {
  return msg === "staffDigest" ? { ...m, roles: m.roles.filter((r) => audience[r]) } : m;
}

export type Prepared = { member: Member; data: WeeklyData | StaffData; empty: boolean };

/** Builds each person's email for one send (nothing is queued). */
export async function prepare(t: Team, c: TeamComms | null, msg: "weekly" | "staffDigest", date: string): Promise<Prepared[]> {
  const e = effective(msg, c)!;
  const site = siteUrl();
  const common = { teamName: t.teamName, teamId: t.teamId, clubName: t.club?.name, colors: t.club?.colors, siteUrl: site, schedule: scheduleText(msg, c) };
  const out: Prepared[] = [];
  for (const m0 of recipients(t, msg, e.audience)) {
    const m = forAudience(m0, msg, e.audience);
    const token = await signUnsub({ sub: m.sub, teamId: t.teamId, msg });
    const unsubscribeUrl = `${site}/unsubscribe#t=${token}`;
    if (msg === "weekly") {
      const content = weeklyContent(t, m, date);
      out.push({ member: m, empty: weeklyIsEmpty(content), data: { ...common, firstName: m.firstName, hideEmpty: e.rules.hideEmpty, unsubscribeUrl, content } });
    } else {
      const content = staffContent(t, m, date);
      out.push({ member: m, empty: staffIsEmpty(content), data: { ...common, firstName: m.firstName, unsubscribeUrl, content } });
    }
  }
  return out;
}

/** The one-click unsubscribe headers Gmail and Yahoo ask bulk senders for (RFC 8058). */
async function unsubHeaders(m: Member, teamId: string, msg: string): Promise<Record<string, string> | undefined> {
  const api = (process.env.API_URL || "").replace(/\/$/, "");
  if (!api) return undefined;
  const token = await signUnsub({ sub: m.sub, teamId, msg });
  return { "List-Unsubscribe": `<${api}/public/unsubscribe?t=${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/** Queues one scheduled send on a team. Returns how many emails were queued and how many skipped as empty. */
export async function send(teamId: string, clubId: string, msg: "weekly" | "staffDigest", date: string, c: TeamComms | null): Promise<{ queued: number; empty: number }> {
  const e = effective(msg, c)!;
  const t = await loadTeam(teamId, clubId);
  const prepared = await prepare(t, c, msg, date);
  const ids: string[] = [];
  let empty = 0;
  for (const p of prepared) {
    if (p.empty && e.rules.skipEmpty) { empty++; continue; }
    const to = p.member.email || String((await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.profile(p.member.sub) }))).Item?.email ?? "");
    if (!to) continue;
    const { id, queued } = await queueEmail({
      msg, to, teamId, clubId, data: p.data as never,
      dedupe: `${msg}:${teamId}:${date}:${p.member.sub}`,
      headers: await unsubHeaders(p.member, teamId, msg)
    });
    if (queued) ids.push(id);
  }
  await dispatch(ids);
  return { queued: ids.length, empty };
}

/** Claims a send so it runs once, however many planner runs see it. */
async function claim(teamId: string, key: string): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)",
      Item: { PK: `RUN#${teamId}`, SK: key, type: "CommsRun", at: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + RUN_DAYS * 86400 }
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
  const sends: { teamId: string; key: string; queued: number; empty: number }[] = [];
  let teams = 0;
  for (const clubId of clubs) {
    const dirs = await queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" } });
    for (const d of dirs.filter((x) => !x.archived)) {
      const teamId = String(d.SK).slice(5);
      const c = await getComms(teamId);
      if (!c) continue; // nothing turned on
      teams++;
      for (const o of dueNow(c, now)) {
        if (!(await claim(teamId, `${o.msg}#${o.date}`))) continue;
        try {
          const r = await send(teamId, clubId, o.msg, o.date, c);
          sends.push({ teamId, key: o.key, ...r });
        } catch (err) {
          console.error(JSON.stringify({ msg: "planner send failed", teamId, key: o.key, error: String(err) }));
          // Let the next run try again; emails already queued aren't queued twice.
          await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RUN#${teamId}`, SK: `${o.msg}#${o.date}` } })).catch(() => {});
        }
      }
    }
  }
  return { teams, sends };
}
