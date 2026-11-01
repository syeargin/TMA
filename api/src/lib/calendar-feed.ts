/**
 * Calendar subscriptions: a private link per person that a calendar app (Apple, Google, Outlook)
 * checks on its own, so the schedule stays up to date there. One link per team, plus one for all
 * of a person's teams. The feed carries the schedule only, as every member already sees it on the
 * site: no family details and no availability answers.
 *
 *   USER#<sub>        / CAL#team#<teamId> | CAL#all   { token, types | teams, app, lastFetchAt, fetches }
 *   CALTOKEN#<sha256> / META                          { sub, key }   finds the link's owner from the link
 *
 * The link holds the token itself; only its hash finds the record, and the token is stored on the
 * owner's own record so the site can show them their link again.
 */
import { createHash, randomBytes } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import type { Item } from "./comms/schedule.js";
import { zonedInstant, localParts } from "./comms/zoned.js";
import type { Team } from "./comms/content.js";

export const CAL_TYPES = ["practice", "tournament", "event"] as const;
export type CalType = (typeof CAL_TYPES)[number];
export const typeOf = (kind: string): CalType => (kind === "practice" ? "practice" : kind === "tournament" ? "tournament" : "event");

export type CalSub = {
  key: string; scope: "team" | "all"; teamId?: string; token: string;
  types?: CalType[]; teams?: Record<string, CalType[]>;
  app?: string; createdAt: string; updatedAt: string; lastFetchAt?: string; fetches?: number;
};

export const subKey = (scope: "team" | "all", teamId?: string) => (scope === "all" ? "CAL#all" : `CAL#team#${teamId}`);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const pointer = (token: string) => ({ PK: `CALTOKEN#${hash(token)}`, SK: "META" });
export const newToken = () => randomBytes(24).toString("base64url");

export async function getSub(sub: string, key: string): Promise<CalSub | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${sub}`, SK: key } }));
  return (r.Item as CalSub | undefined) ?? null;
}

/** Create the link, or change what it includes (the link itself stays the same). */
export async function saveSub(sub: string, s: Pick<CalSub, "scope" | "teamId" | "types" | "teams" | "app">, at: string): Promise<CalSub> {
  const key = subKey(s.scope, s.teamId);
  const old = await getSub(sub, key);
  const item: CalSub = {
    key, scope: s.scope, ...(s.teamId ? { teamId: s.teamId } : {}), token: old?.token ?? newToken(),
    ...(s.scope === "team" ? { types: s.types } : { teams: s.teams }),
    app: s.app ?? old?.app, createdAt: old?.createdAt ?? at, updatedAt: at,
    ...(old?.lastFetchAt ? { lastFetchAt: old.lastFetchAt, fetches: old.fetches } : {})
  };
  const row = { PK: `USER#${sub}`, SK: key, type: "CalendarLink", ...item };
  if (old) await ddb.send(new PutCommand({ TableName: TABLE, Item: row }));
  else await ddb.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: TABLE, Item: row } },
    { Put: { TableName: TABLE, Item: { ...pointer(item.token), type: "CalendarToken", sub, key }, ConditionExpression: "attribute_not_exists(PK)" } }
  ] }));
  return item;
}

/** A new link: the old one stops working at once (for a link shared by mistake). */
export async function resetSub(sub: string, key: string, at: string): Promise<CalSub | null> {
  const old = await getSub(sub, key);
  if (!old) return null;
  const token = newToken();
  await ddb.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: TABLE, Key: { PK: `USER#${sub}`, SK: key }, UpdateExpression: "SET #t = :t, updatedAt = :at REMOVE lastFetchAt, fetches", ExpressionAttributeNames: { "#t": "token" }, ExpressionAttributeValues: { ":t": token, ":at": at } } },
    { Delete: { TableName: TABLE, Key: pointer(old.token) } },
    { Put: { TableName: TABLE, Item: { ...pointer(token), type: "CalendarToken", sub, key } } }
  ] }));
  return { ...old, token, updatedAt: at, lastFetchAt: undefined, fetches: undefined };
}

export async function stopSub(sub: string, key: string): Promise<boolean> {
  const old = await getSub(sub, key);
  if (!old) return false;
  await ddb.send(new TransactWriteCommand({ TransactItems: [
    { Delete: { TableName: TABLE, Key: { PK: `USER#${sub}`, SK: key } } },
    { Delete: { TableName: TABLE, Key: pointer(old.token) } }
  ] }));
  return true;
}

/** Every key to delete with an account (lib: routes/account.ts). */
export const subKeysFor = (sub: string, subs: Record<string, unknown>[]) =>
  subs.flatMap((s) => [{ PK: `USER#${sub}`, SK: String(s.SK) }, ...(typeof s.token === "string" ? [pointer(s.token)] : [])]);

export async function byToken(token: string): Promise<{ sub: string; s: CalSub } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const p = await ddb.send(new GetCommand({ TableName: TABLE, Key: pointer(token) }));
  if (!p.Item) return null;
  const sub = String(p.Item.sub);
  const s = await getSub(sub, String(p.Item.key));
  return s && s.token === token ? { sub, s } : null;
}

/** When the calendar app last checked (written at most every 15 minutes). */
export async function noteFetch(sub: string, s: CalSub, at = new Date()) {
  if (s.lastFetchAt && at.getTime() - Date.parse(s.lastFetchAt) < 15 * 60_000) return;
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `USER#${sub}`, SK: s.key }, ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: "SET lastFetchAt = :at ADD fetches :one", ExpressionAttributeValues: { ":at": at.toISOString(), ":one": 1 }
  })).catch(() => { /* stopped meanwhile */ });
}

// ---------- the .ics file ----------

const pad = (n: number) => String(n).padStart(2, "0");
const utc = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const compact = (s: string) => s.replace(/-/g, "");
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
/** Lines longer than 75 octets continue on the next line after a space (RFC 5545). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = " " + ch; } else cur += ch;
  }
  return [...out, cur].join("\r\n");
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** "6:30 PM", "6 PM" or "18:30" → "18:30"; "" when there's no time. A start without AM/PM takes the end's ("6 – 8 PM"). */
function hhmm(t: string, meridiem = ""): string {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);
  if (!m || (!m[2] && !m[3] && !meridiem)) return "";
  const ap = (m[3] || meridiem).toUpperCase();
  let h = +m[1];
  if (h > 23 || +(m[2] ?? 0) > 59) return "";
  if (ap) h = (h % 12) + (ap === "PM" ? 12 : 0);
  return `${pad(h)}:${pad(+(m[2] ?? 0))}`;
}

export type FeedTeam = { team: Team; zone: string; types: CalType[]; prefix: boolean };

/** One schedule item as a VEVENT. Cancelled dates stay, marked "Cancelled:", so nothing silently vanishes. */
function vevent(t: FeedTeam, it: Item, site: string, stamp: string): string[] {
  const e = t.team.events.find((x) => x.eid === it.eid) ?? {};
  const title = it.kind === "practice" && !/practice/i.test(it.title) ? `${it.title} practice` : it.title;
  const summary = `${it.cancelled ? "Cancelled: " : ""}${t.prefix ? `${t.team.teamName} · ` : ""}${title}`;
  const court = str(e.court);
  const location = [it.location, court ? (/court/i.test(court) ? court : `Court ${court}`) : "", str(e.address)].filter(Boolean).join(", ");
  const page = it.kind === "tournament" && it.eid ? `${site}/teams/${t.team.teamId}/tournaments/${it.eid}` : `${site}/teams/${t.team.teamId}/schedule`;
  const details = it.kind === "tournament"
    ? [
        str(e.arrival) ? `Arrive ${str(e.arrival)}` : "", str(e.start) ? `First match ${str(e.start)}` : "", str(e.waves), str(e.meet) ? `Meet: ${str(e.meet)}` : "",
        str(e.uniforms) ? `Uniform: ${str(e.uniforms)}` : "", str(e.hotel) ? `Hotel: ${str(e.hotel)}${str(e.hotelCode) ? ` (code ${str(e.hotelCode)})` : ""}` : "",
        `Game-day sheet: ${page}`
      ].filter(Boolean).join("\n")
    : [str(e.uniformColor) ? `Practice uniform: ${str(e.uniformColor)}` : "", it.note, `Teem Hub: ${page}`].filter(Boolean).join("\n\n");

  const [from = "", to = ""] = it.time.split(/\s*[–-]\s*/);
  const endAp = /(AM|PM)/i.exec(to)?.[1] ?? "";
  const start = it.kind === "tournament" || it.kind === "deadline" ? "" : hhmm(from, /(AM|PM)/i.test(from) ? "" : endAp);
  let when: string[];
  if (!start) when = [`DTSTART;VALUE=DATE:${compact(it.date)}`, `DTEND;VALUE=DATE:${compact(plusDays(it.end || it.date, 1))}`];
  else {
    const s = zonedInstant(it.date, start, t.zone);
    const endHm = to ? hhmm(to) : "";
    let en = endHm ? zonedInstant(it.date, endHm, t.zone) : new Date(s.getTime() + 2 * 3600_000);
    if (en <= s) en = new Date(s.getTime() + 2 * 3600_000);
    when = [`DTSTART:${utc(s)}`, `DTEND:${utc(en)}`];
  }
  return [
    "BEGIN:VEVENT", `UID:${t.team.teamId}-${it.key}@feed.teemhub.net`, `DTSTAMP:${stamp}`, ...when,
    `SUMMARY:${esc(summary)}`, ...(location ? [`LOCATION:${esc(location)}`] : []), `DESCRIPTION:${esc(details)}`, `URL:${page}`,
    ...(it.cancelled ? ["TRANSP:TRANSPARENT"] : []), "END:VEVENT"
  ];
}

/** The whole calendar: everything from 30 days ago on, for the chosen kinds of event. */
export function feedIcs(name: string, teams: FeedTeam[], site: string, now = new Date()): string {
  const stamp = utc(now);
  const zone = teams[0]?.zone ?? "America/New_York";
  const from = plusDays(localParts(now, zone).date, -30);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Teem Hub//Calendar link//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`, `X-WR-CALDESC:${esc("From Teem Hub. Updates on its own when the schedule changes.")}`, `X-WR-TIMEZONE:${zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"
  ];
  for (const t of teams) {
    for (const it of t.team.items) {
      if ((it.end || it.date) < from || !t.types.includes(typeOf(it.kind))) continue;
      lines.push(...vevent(t, it, site, stamp));
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
