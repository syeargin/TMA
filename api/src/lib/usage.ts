/**
 * Site usage counts for the site admin's Usage and Health tabs. Totals only, kept 13 months:
 *
 *   USAGE#<yyyy-mm> / D#<dd>#P#<club>#<team>#<area>          page opens ("-" for pages outside a team)
 *                     D#<dd>#HR#<hh>                         page opens by hour (Eastern), every club
 *                     D#<dd>#V#<club>#<source>               visits by how they started
 *                     D#<dd>#DEV#<club>#<device>             visits by device
 *                     D#<dd>#ACT#<club>#<team>#<action>      things people did
 *                     D#<dd>#L#<device>#<area>#<bucket>      how long pages took to open
 *                     W#<week start>#<club>#<team>#<kind>    people active that week (family or staff)
 *   HEALTH#<yyyy-mm>  / D#<dd>#H#<hh>   { n, err }           API requests per hour, and the ones that failed
 *                     D#<dd>#E#<area>   { n, lastAt, status } failed requests by page
 *                     D#<dd>#CE#<area>  { n }                errors in people's browsers, by page
 *   RELEASES          / C#<commit>      { at }               when a release was first opened
 *   SEEN#<team>       / <sub>           { day, week, kind }  the last day each member opened the team
 *
 * SEEN# is the one record about a person: it lets us count each member once a day and once a week.
 * Site owners only ever see totals. It sits outside TEAM# so it never sets off live updates.
 * Days and hours are Eastern time (most clubs are), and weeks start on Sunday.
 */
import { QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import { localParts } from "./comms/zoned.js";
import { DEFAULT_TIME_ZONE } from "../shared/messages.js";
import { bucketOf, kindOf, type Action, type Area, type Device, type Source } from "../shared/usage.js";

export const USAGE_ZONE = DEFAULT_TIME_ZONE;
export const KEEP_MONTHS = 13;

/** Eastern date and hour of a moment. */
export function stamp(at = new Date()) {
  const p = localParts(at, USAGE_ZONE);
  return { date: p.date, month: p.date.slice(0, 7), dd: p.date.slice(8, 10), hour: p.hhmm.slice(0, 2) };
}

export const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** The Sunday a week starts on. */
export const weekOf = (date: string) => plusDays(date, -new Date(`${date}T12:00:00Z`).getUTCDay());
/** Deleted on its own 13 months after the month it counts. */
export const ttlFor = (date: string) => Math.floor(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1 + KEEP_MONTHS, 1) / 1000);

const NAME = /^[a-zA-Z]+$/;
async function add(pk: string, sk: string, date: string, adds: Record<string, number>, sets: Record<string, string | number> = {}) {
  const names: Record<string, string> = { "#t": "type", "#ttl": "ttl" };
  const values: Record<string, unknown> = { ":type": pk.split("#")[0] === "HEALTH" ? "HealthCount" : "UsageCount", ":ttl": ttlFor(date) };
  const addParts: string[] = [];
  for (const [k, v] of Object.entries(adds)) {
    if (!NAME.test(k)) throw new Error(`bad counter ${k}`);
    names[`#${k}`] = k; values[`:${k}`] = v; addParts.push(`#${k} :${k}`);
  }
  const setParts = ["#t = if_not_exists(#t, :type)", "#ttl = if_not_exists(#ttl, :ttl)"];
  for (const [k, v] of Object.entries(sets)) {
    if (!NAME.test(k)) throw new Error(`bad field ${k}`);
    names[`#${k}`] = k; values[`:s${k}`] = v; setParts.push(`#${k} = :s${k}`);
  }
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: pk, SK: sk },
    UpdateExpression: `SET ${setParts.join(", ")} ADD ${addParts.join(", ")}`,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values
  }));
}

/** Counting must never break what the person was doing. */
export async function quietly(p: Promise<unknown>) {
  try { await p; } catch (e) { console.warn(JSON.stringify({ msg: "usage count failed", error: String(e) })); }
}

/** One API request (every request but the counters' own). */
export async function countRequest(status: number, area: string, at = new Date()) {
  const s = stamp(at);
  const failed = status >= 500;
  await Promise.all([
    add(`HEALTH#${s.month}`, `D#${s.dd}#H#${s.hour}`, s.date, { n: 1, err: failed ? 1 : 0 }),
    ...(failed ? [add(`HEALTH#${s.month}`, `D#${s.dd}#E#${area}`, s.date, { n: 1 }, { lastAt: at.toISOString(), status })] : [])
  ]);
}

export async function countAction(clubId: string, teamId: string, action: Action, at = new Date()) {
  const s = stamp(at);
  await add(`USAGE#${s.month}`, `D#${s.dd}#ACT#${clubId || "-"}#${teamId || "-"}#${action}`, s.date, { n: 1 });
}

export type View = { clubId: string; teamId: string; area: Area; device: Device; source?: Source; ms?: number };

/** One page opened. The first page of a visit also says how the visit started. */
export async function countView(v: View, at = new Date()) {
  const s = stamp(at);
  const pk = `USAGE#${s.month}`;
  const club = v.clubId || "-";
  const writes = [
    add(pk, `D#${s.dd}#P#${club}#${v.teamId || "-"}#${v.area}`, s.date, { n: 1 }),
    add(pk, `D#${s.dd}#HR#${s.hour}`, s.date, { n: 1 })
  ];
  if (v.source) writes.push(add(pk, `D#${s.dd}#V#${club}#${v.source}`, s.date, { n: 1 }), add(pk, `D#${s.dd}#DEV#${club}#${v.device}`, s.date, { n: 1 }));
  if (v.ms !== undefined) writes.push(add(pk, `D#${s.dd}#L#${v.device}#${v.area}#${bucketOf(v.ms)}`, s.date, { n: 1 }));
  await Promise.all(writes);
}

export async function countBrowserError(area: Area, at = new Date()) {
  const s = stamp(at);
  await add(`HEALTH#${s.month}`, `D#${s.dd}#CE#${area}`, s.date, { n: 1 });
}

/** The first time anyone opens a release of the site: roughly when it went out. */
export async function noteRelease(commit: string, at = new Date()) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: "RELEASES", SK: `C#${commit}` },
    UpdateExpression: "SET #t = if_not_exists(#t, :type), #at = if_not_exists(#at, :at), #c = :c, #ttl = :ttl",
    ExpressionAttributeNames: { "#t": "type", "#at": "at", "#c": "commit", "#ttl": "ttl" },
    ExpressionAttributeValues: { ":type": "Release", ":at": at.toISOString(), ":c": commit, ":ttl": ttlFor(stamp(at).date) }
  }));
}

/**
 * A member opened their team: remember the day (once a day), and count them once for the week.
 * Club admins and site owners looking at a team they don't belong to aren't counted.
 */
export async function markSeen(clubId: string, teamId: string, sub: string, roles: readonly string[], at = new Date()) {
  const s = stamp(at);
  const week = weekOf(s.date);
  const kind = kindOf(roles);
  let old: Record<string, unknown> | undefined;
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { PK: `SEEN#${teamId}`, SK: sub },
      ConditionExpression: "attribute_not_exists(#day) OR #day <> :day",
      UpdateExpression: "SET #t = :type, #day = :day, #week = :week, #kind = :kind, clubId = :club, #ttl = :ttl",
      ExpressionAttributeNames: { "#t": "type", "#day": "day", "#week": "week", "#kind": "kind", "#ttl": "ttl" },
      ExpressionAttributeValues: { ":type": "Seen", ":day": s.date, ":week": week, ":kind": kind, ":club": clubId, ":ttl": ttlFor(s.date) },
      ReturnValues: "ALL_OLD"
    }));
    old = res.Attributes;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false; // already counted today
    throw e;
  }
  if (old?.week !== week) await add(`USAGE#${week.slice(0, 7)}`, `W#${week}#${clubId}#${teamId}#${kind}`, week, { n: 1 });
  return true;
}

/** Someone left the team or deleted their account. */
export async function forgetSeen(teamId: string, sub: string) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `SEEN#${teamId}`, SK: sub } }));
}

// ---------- reading ----------

export type Row = Record<string, unknown> & { PK: string; SK: string };

async function all(params: { pk: string; from?: string; to?: string; prefix?: string }): Promise<Row[]> {
  const out: Row[] = [];
  let start: Record<string, unknown> | undefined;
  const values: Record<string, unknown> = { ":p": params.pk };
  let cond = "PK = :p";
  if (params.from !== undefined && params.to !== undefined) { cond += " AND SK BETWEEN :a AND :b"; values[":a"] = params.from; values[":b"] = params.to; }
  else if (params.prefix) { cond += " AND begins_with(SK, :x)"; values[":x"] = params.prefix; }
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: cond, ExpressionAttributeValues: values, ExclusiveStartKey: start }));
    out.push(...((res.Items ?? []) as Row[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** The months from `from` to `to` (YYYY-MM-DD), oldest first. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  const last = to.slice(0, 7);
  for (let i = 0; i < 40; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= last) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** Daily rows (D#) of one kind between two dates, each with its date. */
export async function dailyRows(prefix: "USAGE" | "HEALTH", from: string, to: string): Promise<(Row & { date: string })[]> {
  const parts = await Promise.all(monthsBetween(from, to).map((m) => {
    const lo = m === from.slice(0, 7) ? from.slice(8, 10) : "01";
    const hi = m === to.slice(0, 7) ? to.slice(8, 10) : "31";
    return all({ pk: `${prefix}#${m}`, from: `D#${lo}#`, to: `D#${hi}#~` }).then((rows) => rows.map((r) => ({ ...r, date: `${m}-${String(r.SK).slice(2, 4)}` })));
  }));
  return parts.flat();
}

/** Weekly active rows (W#) for weeks starting between two dates. */
export async function weeklyRows(from: string, to: string): Promise<Row[]> {
  const parts = await Promise.all(monthsBetween(from, to).map((m) => all({ pk: `USAGE#${m}`, from: `W#${from}`, to: `W#${to}~` })));
  return parts.flat();
}

export async function seenRows(teamId: string): Promise<Row[]> {
  return all({ pk: `SEEN#${teamId}` });
}

/** A deleted team's counts (lib/retention.ts): the rows that name it, from every month still kept. */
export async function teamUsageKeys(teamId: string, at = new Date()): Promise<{ PK: string; SK: string }[]> {
  const to = stamp(at).date;
  const from = plusDays(to, -31 * (KEEP_MONTHS + 1));
  const parts = await Promise.all(monthsBetween(from, to).map(async (m) => {
    const out: { PK: string; SK: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE, KeyConditionExpression: "PK = :p", ProjectionExpression: "PK, SK",
        ExpressionAttributeValues: { ":p": `USAGE#${m}` }, ExclusiveStartKey: start
      }));
      // DynamoDB can't filter on a key attribute, so the rows naming the team are picked out here.
      out.push(...(res.Items ?? []).filter((i) => String(i.SK).includes(`#${teamId}#`)).map((i) => ({ PK: String(i.PK), SK: String(i.SK) })));
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  }));
  return parts.flat();
}

export async function releases(): Promise<Row[]> {
  return all({ pk: "RELEASES" });
}
