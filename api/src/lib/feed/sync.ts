/**
 * Calendar feed sync, stage C2: imports a team's feed into its schedule and keeps it up to date.
 *
 * Each feed event becomes an ordinary event (TEAM#t / EVENT#<eid>) with a `src` block saying where it
 * came from. Its id comes from the feed's id, so it stays the same on every sync and availability
 * answers, attendance, meals and ref jobs keep hanging on it. The feed only ever writes the fields it
 * owns (FEED_OWNED: title, dates, times, venue, address, court) plus whether it's cancelled, and the
 * type until an admin picks one. Everything the team adds stays.
 *
 * A sync never deletes or cancels an event because it's gone from the feed: it counts the syncs it's
 * been missing for, and an admin decides (stage C3). Unchanged events aren't written at all.
 *
 * TEAM#t / FEED#SYNC#<at>         one row per sync run (kept 90 days)
 * TEAM#t / FEED#CHG#<at>#<eid>    one row per changed event (kept a year)
 */
import { createHash } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { keys } from "../keys.js";
import { getComms, zoneOf } from "../comms/planner.js";
import { localParts } from "../comms/zoned.js";
import { expandPattern, shortDate } from "../comms/schedule.js";
import { convertPractices } from "../practices.js";
import { clubOfTeam } from "../clubs.js";
import { getControls, isActive } from "../club-controls.js";
import { addDays, FeedError, parseFeed } from "./ical.js";
import { loadFeed } from "./fetch.js";
import { openLink } from "./secret.js";
import { applyRules, FEED_OWNED, feedFields, FEED_KIND_LABELS, type EventSource, type FeedFields, type FeedRules } from "../../shared/feed-rules.js";
import { effectiveFeatures, isOn, type FeatureMap } from "../../shared/features.js";
import { deleteMany, getItem, putItem, putMany, queryAll } from "../../api/util.js";

type Row = Record<string, unknown>;
const DAY = 86400;
export const MANUAL_EVERY_MS = 5 * 60_000;

export const eidFor = (uid: string) => `fd${createHash("sha256").update(uid).digest("hex").slice(0, 14)}`;

/** The feed fields as they'd be stored, for comparing. The type counts only while the feed decides it. */
export function fingerprint(f: FeedFields, kindSet: boolean): string {
  const parts: Record<string, unknown> = { cancelled: f.cancelled };
  for (const k of FEED_OWNED) if (f[k]) parts[k] = f[k];
  if (!kindSet) parts.kind = f.kind;
  return createHash("sha1").update(JSON.stringify(Object.keys(parts).sort().map((k) => [k, parts[k]]))).digest("base64url").slice(0, 16);
}

/** The feed fields an event has now. */
function currentFields(e: Row): FeedFields {
  const f: FeedFields = { kind: e.kind as FeedFields["kind"], cancelled: ((e.cancelled as string[] | undefined) ?? []).includes(String(e.date)) };
  for (const k of FEED_OWNED) if (e[k]) f[k] = String(e[k]);
  return f;
}

const an = (k: string) => (/^[aeiou]/i.test(k) ? `an ${k}` : `a ${k}`);

/** "now 8:00 AM (was 7:30 AM); now Court 9 (was Court 6)". */
export function changeText(was: FeedFields, now: FeedFields, kindSet: boolean): string {
  const out: string[] = [];
  if (was.cancelled !== now.cancelled) out.push(now.cancelled ? "cancelled" : "back on");
  if (was.date !== now.date) out.push(`moved to ${shortDate(now.date!)} (was ${shortDate(was.date!)})`);
  if (was.time !== now.time) out.push(now.time ? `now ${now.time}${was.time ? ` (was ${was.time})` : ""}` : "no start time now");
  else if (was.endTime !== now.endTime && now.endTime) out.push(`now ends ${now.endTime}${was.endTime ? ` (was ${was.endTime})` : ""}`);
  if (was.endDate !== now.endDate && was.date === now.date) out.push(`now ends ${shortDate(now.endDate ?? now.date!)}`);
  if (was.court !== now.court) out.push(now.court ? `now ${now.court}${was.court ? ` (was ${was.court})` : ""}` : "no court listed now");
  if (was.location !== now.location) out.push(now.location ? `now at ${now.location}` : "no place listed now");
  if (was.title !== now.title) out.push(`renamed "${now.title}"`);
  if (!kindSet && was.kind !== now.kind) out.push(`now ${an(FEED_KIND_LABELS[now.kind].toLowerCase())}`);
  if (!out.length && was.address !== now.address) out.push("new address");
  return out.length > 3 ? `${out.slice(0, 3).join("; ")} and more` : out.join("; ");
}

export type SyncRun = {
  at: string; ok: boolean; trigger: "import" | "job" | "manual";
  added: number; changed: number; unchanged: number; missing: number; total: number;
  error?: string; code?: string; ms: number;
  changes: { eid: string; title: string; date: string; text: string }[];
};

type Source = Row & { link: string; version: number; importFrom?: string; importedAt?: string };

/** Rules of the version the source points at. */
async function currentRules(teamId: string, version: number): Promise<FeedRules> {
  const v = await getItem(keys.feedRules(teamId, version));
  if (!v) throw new FeedError("feed_no_rules", "The feed's rules are missing. Save them again under Team info › Calendar feed.");
  return v.rules as FeedRules;
}

/** Only one sync per team at a time (the job, Sync now and an import can meet). */
async function lock(teamId: string, ms = 120_000): Promise<boolean> {
  const t = Date.now();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.feedSource(teamId), UpdateExpression: "SET lockUntil = :until",
      ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(lockUntil) OR lockUntil < :now)",
      ExpressionAttributeValues: { ":until": t + ms, ":now": t }
    }));
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}
const unlock = (teamId: string) => ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.feedSource(teamId), UpdateExpression: "REMOVE lockUntil", ConditionExpression: "attribute_exists(PK)" })).catch(() => undefined);

/** The team's events, split into feed events (by feed id) and the rest. */
async function teamEvents(teamId: string) {
  const rows = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :e)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":e": "EVENT#" } });
  const events = rows.filter((r) => String(r.SK).split("#").length === 2).map((r): Row & { eid: string } => ({ ...r, eid: String(r.SK).slice(6) }));
  const fromFeed = new Map<string, Row & { eid: string }>();
  for (const e of events) if (e.src) fromFeed.set(String((e.src as EventSource).uid), e);
  return { events, fromFeed };
}

/**
 * Reads the feed and brings the team's events in line with it. `importFrom` is where the schedule
 * starts taking feed events (set when the feed was imported); earlier events are left alone.
 */
export async function syncTeam(teamId: string, opt: { trigger: SyncRun["trigger"]; by: string; importFrom?: string }): Promise<SyncRun> {
  const started = Date.now();
  const at = new Date().toISOString();
  const run: SyncRun = { at, ok: false, trigger: opt.trigger, added: 0, changed: 0, unchanged: 0, missing: 0, total: 0, ms: 0, changes: [] };
  const src = (await getItem(keys.feedSource(teamId))) as Source | undefined;
  if (!src) throw new FeedError("feed_missing", "This team has no calendar feed.");
  const from = opt.importFrom ?? src.importFrom;
  if (!from) throw new FeedError("feed_not_imported", "Import the feed first.");
  try {
    const rules = await currentRules(teamId, src.version);
    const zone = zoneOf(await getComms(teamId));
    const today = localParts(new Date(), zone).date;
    const got = await loadFeed(await openLink(src.link, teamId));
    const parsed = parseFeed(got.body, { teamZone: zone, windowStart: addDays(today, -400), windowEnd: addDays(today, 550) });
    const matched = applyRules(parsed.events, rules).matched.filter((m) => m.endDate >= from);
    run.total = matched.length;
    const { fromFeed } = await teamEvents(teamId);
    const seen = new Set<string>();
    const added: Row[] = [];
    const chgRows: Row[] = [];
    for (const m of matched) {
      if (seen.has(m.uid)) continue;
      seen.add(m.uid);
      const f = feedFields(m);
      const old = fromFeed.get(m.uid);
      if (!old) {
        const eid = eidFor(m.uid);
        const s: EventSource = { uid: m.uid, fp: fingerprint(f, false), added: at, rulesV: src.version };
        const { cancelled, ...fields } = f;
        added.push({
          ...keys.event(teamId, eid), type: "Event", ...fields, travel: false, ...(cancelled ? { cancelled: [f.date] } : {}),
          src: s, GSI2PK: `TEAM#${teamId}#CAL`, GSI2SK: `${f.date}#${eid}`, updatedAt: at, updatedBy: opt.by
        });
        run.added++;
        continue;
      }
      const s = old.src as EventSource;
      const kindSet = !!s.kindSet;
      const fp = fingerprint(f, kindSet);
      if (fp === s.fp) {
        run.unchanged++;
        if (s.missing) await setMissing(teamId, old.eid, 0);
        continue;
      }
      const was = currentFields(old);
      const text = changeText(was, f, kindSet);
      await writeChange(teamId, old, f, kindSet, { ...s, fp, rulesV: src.version, ...(text ? { change: { at, text } } : {}) }, at, opt.by);
      if (text) {
        run.changed++;
        const fields: Record<string, { was?: string | boolean; now?: string | boolean }> = {};
        for (const k of [...FEED_OWNED, "cancelled", "kind"] as const) if ((was as Row)[k] !== (f as Row)[k] && !(k === "kind" && kindSet)) fields[k] = { was: (was as Row)[k] as string, now: (f as Row)[k] as string };
        const reason = s.rulesV !== src.version ? "rules" : "feed";
        chgRows.push({ PK: `TEAM#${teamId}`, SK: `FEED#CHG#${at}#${old.eid}`, type: "FeedChange", eid: old.eid, at, title: f.title, date: f.date, text, fields, reason, ttl: Math.floor(Date.now() / 1000) + 365 * DAY });
        run.changes.push({ eid: old.eid, title: String(f.title), date: String(f.date), text });
      } else run.unchanged++;
    }
    // Events gone from the feed: counted, never removed here. Ones that already happened don't count.
    for (const [uid, e] of fromFeed) {
      if (seen.has(uid)) continue;
      if ((String(e.endDate || e.date)) < today) continue;
      const s = e.src as EventSource;
      run.missing++;
      await setMissing(teamId, e.eid, (s.missing ?? 0) + 1, s.missingSince ?? at);
    }
    await putMany(added);
    await putMany(chgRows);
    run.ok = true;
  } catch (e) {
    run.error = e instanceof FeedError ? e.message : "Something went wrong reading the feed.";
    run.code = e instanceof FeedError ? e.code : "error";
    if (!(e instanceof FeedError)) console.error(JSON.stringify({ msg: "feed sync error", teamId, error: String(e), stack: (e as Error)?.stack }));
  }
  run.ms = Date.now() - started;
  const { changes, ...summary } = run;
  await putItem({ PK: `TEAM#${teamId}`, SK: `FEED#SYNC#${at}`, type: "FeedSync", ...summary, changes: changes.slice(0, 20), ttl: Math.floor(Date.now() / 1000) + 90 * DAY });
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.feedSource(teamId), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: run.ok ? "SET lastSync = :s, lastOkAt = :at, failures = :zero" : "SET lastSync = :s ADD failures :one",
    ExpressionAttributeValues: run.ok ? { ":s": summary, ":at": at, ":zero": 0 } : { ":s": summary, ":one": 1 }
  })).catch(() => undefined);
  console.log(JSON.stringify({ msg: "feed synced", teamId, trigger: run.trigger, ok: run.ok, added: run.added, changed: run.changed, missing: run.missing, total: run.total, ms: run.ms, code: run.code }));
  return run;
}

async function setMissing(teamId: string, eid: string, n: number, since?: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.event(teamId, eid), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: n ? "SET #s.#m = :n, #s.#ms = :since" : "REMOVE #s.#m, #s.#ms",
    ExpressionAttributeNames: { "#s": "src", "#m": "missing", "#ms": "missingSince" },
    ExpressionAttributeValues: n ? { ":n": n, ":since": since } : undefined
  })).catch((e) => console.error(JSON.stringify({ msg: "feed missing count not saved", teamId, eid, error: String(e) })));
}

/** Writes only the feed's fields (and the type while the feed decides it); the team's stay. */
async function writeChange(teamId: string, old: Row & { eid: string }, f: FeedFields, kindSet: boolean, s: EventSource, at: string, by: string) {
  const sets = ["src = :src", "updatedAt = :at", "updatedBy = :by", "GSI2SK = :g"];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const { missing: _m, missingSince: _ms, ...kept } = s;
  const values: Record<string, unknown> = { ":src": kept, ":at": at, ":by": by, ":g": `${f.date}#${old.eid}` };
  for (const k of FEED_OWNED) {
    names[`#${k}`] = k;
    if (f[k]) { sets.push(`#${k} = :${k}`); values[`:${k}`] = f[k]; } else removes.push(`#${k}`);
  }
  if (!kindSet) { names["#kind"] = "kind"; sets.push("#kind = :kind"); values[":kind"] = f.kind; }
  names["#cancelled"] = "cancelled";
  if (f.cancelled) { sets.push("#cancelled = :c"); values[":c"] = [f.date]; } else removes.push("#cancelled");
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.event(teamId, old.eid), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values
  }));
}

// ---------- Import ----------

export type ReplaceResult = { practicesRemoved: number; seriesEnded: number; answersMoved: number; attendanceMoved: number };

/**
 * Hand-entered practices from `from` on give way to the feed's practices. Families' answers and
 * attendance on a hand-entered date move to the feed practice on the same day (the earliest, when
 * there are two). Series that started earlier end the day before; later ones and single practices go.
 */
export async function replaceHandPractices(teamId: string, from: string, by: string): Promise<ReplaceResult> {
  const res: ReplaceResult = { practicesRemoved: 0, seriesEnded: 0, answersMoved: 0, attendanceMoved: 0 };
  // Weekly practices still kept the old way (team settings) become events first, answers and all.
  const settings = await getItem(keys.settings(teamId));
  if (((settings?.practices as unknown[] | undefined) ?? []).length) await convertPractices(teamId, by);
  const { events } = await teamEvents(teamId);
  const feedPractices = events.filter((e) => e.src && e.kind === "practice" && !((e.cancelled as string[] | undefined) ?? []).includes(String(e.date)) && String(e.date) >= from)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time ?? "").localeCompare(String(b.time ?? "")));
  const feedOn = new Map<string, string>();
  for (const e of feedPractices) if (!feedOn.has(String(e.date))) feedOn.set(String(e.date), e.eid);

  const moves = new Map<string, string>(); // old answer/attendance key → feed event id
  const removals: { PK: string; SK: string }[] = [];
  for (const e of events.filter((x) => !x.src && x.kind === "practice")) {
    const r = e.repeat as { every: number; days: number[]; until: string } | undefined;
    if (!r) {
      if (String(e.date) < from) continue;
      const to = feedOn.get(String(e.date));
      if (to) moves.set(e.eid, to);
      removals.push(keys.event(teamId, e.eid));
      res.practicesRemoved++;
      continue;
    }
    if (r.until < from) continue;
    const skip = new Set((e.skip as string[] | undefined) ?? []);
    for (const d of expandPattern(String(e.date), r.until, r.days, r.every)) {
      if (d < from || skip.has(d)) continue;
      const to = feedOn.get(d);
      if (to) moves.set(`${e.eid}-${d}`, to);
    }
    if (String(e.date) >= from) {
      const children = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": `EVENT#${e.eid}#` }, ProjectionExpression: "PK, SK" });
      removals.push(keys.event(teamId, e.eid), ...(children as { PK: string; SK: string }[]));
      res.practicesRemoved++;
    } else {
      const before = (list: unknown) => ((list as string[] | undefined) ?? []).filter((d) => d < from);
      const overrides = Object.fromEntries(Object.entries((e.overrides ?? {}) as Row).filter(([d]) => d < from));
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: keys.event(teamId, e.eid),
        UpdateExpression: "SET #r.#u = :u, cancelled = :c, skip = :s, overrides = :o, updatedAt = :at, updatedBy = :by",
        ExpressionAttributeNames: { "#r": "repeat", "#u": "until" },
        ExpressionAttributeValues: { ":u": addDays(from, -1), ":c": before(e.cancelled), ":s": before(e.skip), ":o": overrides, ":at": new Date().toISOString(), ":by": by }
      }));
      res.seriesEnded++;
    }
  }

  if (moves.size) {
    const families = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :f)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":f": "FAMILY#" } });
    for (const fam of families) {
      const rsvp = { ...((fam.rsvp ?? {}) as Row) };
      let n = 0;
      for (const [k, to] of moves) if (rsvp[k]) { if (!rsvp[to]) { rsvp[to] = rsvp[k]; n++; } delete rsvp[k]; }
      if (!n && Object.keys(rsvp).length === Object.keys((fam.rsvp ?? {}) as Row).length) continue;
      await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { PK: String(fam.PK), SK: String(fam.SK) }, UpdateExpression: "SET rsvp = :r", ExpressionAttributeValues: { ":r": rsvp } }));
      res.answersMoved += n;
    }
    for (const [k, to] of moves) {
      const att = await getItem(keys.attendance(teamId, k));
      if (!att) continue;
      if (!(await getItem(keys.attendance(teamId, to)))) {
        const { PK: _p, SK: _s, ...rest } = att;
        await putItem({ ...keys.attendance(teamId, to), ...rest, key: to });
        res.attendanceMoved++;
      }
      removals.push(keys.attendance(teamId, k));
    }
  }
  await deleteMany(removals);
  return res;
}

/** First import: the feed's events from `from` on go onto the schedule, and the regular sync starts. */
export async function importFeed(teamId: string, opt: { from: string; replaceFrom: string | null; by: string }) {
  const run = await syncTeam(teamId, { trigger: "import", by: opt.by, importFrom: opt.from });
  if (!run.ok) return { run, replaced: null };
  const at = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.feedSource(teamId), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: "SET importFrom = :f, importedAt = :at, importedBy = :by, GSI2PK = :g, GSI2SK = :t",
    ExpressionAttributeValues: { ":f": opt.from, ":at": at, ":by": opt.by, ":g": "FEEDS", ":t": teamId }
  }));
  const replaced = opt.replaceFrom ? await replaceHandPractices(teamId, opt.replaceFrom, opt.by) : null;
  console.log(JSON.stringify({ msg: "feed imported", teamId, by: opt.by, from: opt.from, added: run.added, replaced }));
  return { run, replaced };
}

/** Disconnect: imported events stay as ordinary team events; the link, rules and history go. */
export async function disconnect(teamId: string) {
  const { fromFeed } = await teamEvents(teamId);
  for (const e of fromFeed.values()) {
    await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.event(teamId, e.eid), UpdateExpression: "REMOVE src", ConditionExpression: "attribute_exists(PK)" })).catch(() => undefined);
  }
  const items = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": "FEED#" }, ProjectionExpression: "PK, SK" });
  await deleteMany(items.map((i) => ({ PK: String(i.PK), SK: String(i.SK) })));
  return { kept: fromFeed.size };
}

// ---------- Is it syncing? ----------

/** Whether the feed is in charge of its events right now: imported, and the feature on for the team and its club. */
export async function feedActive(teamId: string, features?: FeatureMap): Promise<boolean> {
  const src = await getItem(keys.feedSource(teamId));
  if (!src?.importedAt) return false;
  if (features) return isOn(features, "calfeed");
  const clubId = await clubOfTeam(teamId);
  const [settings, controls] = await Promise.all([getItem(keys.settings(teamId)), getControls(clubId)]);
  return isOn(effectiveFeatures(settings?.features as FeatureMap, controls.features), "calfeed");
}

// ---------- The scheduled job ----------

/** Every 30 minutes (template.yaml FeedSyncFunction): syncs every imported feed whose team and club allow it. */
export async function runFeedSync(opt: { concurrency?: number } = {}) {
  const sources = await queryAll({ IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :g", ExpressionAttributeValues: { ":g": "FEEDS" } });
  const out = { teams: sources.length, synced: 0, skipped: 0, failed: 0 };
  const queue = sources.map((s) => String(s.GSI2SK));
  const worker = async () => {
    for (let teamId = queue.shift(); teamId; teamId = queue.shift()) {
      try {
        const clubId = await clubOfTeam(teamId);
        const [controls, dir, settings] = await Promise.all([getControls(clubId), getItem(keys.teamDir(clubId, teamId)), getItem(keys.settings(teamId))]);
        if (!isActive(controls) || dir?.archived || !isOn(effectiveFeatures(settings?.features as FeatureMap, controls.features), "calfeed")) { out.skipped++; continue; }
        if (!(await lock(teamId))) { out.skipped++; continue; }
        try {
          const run = await syncTeam(teamId, { trigger: "job", by: "feed" });
          if (run.ok) out.synced++; else out.failed++;
        } finally { await unlock(teamId); }
      } catch (e) {
        out.failed++;
        console.error(JSON.stringify({ msg: "feed job team failed", teamId, error: String(e) }));
      }
    }
  };
  await Promise.all(Array.from({ length: opt.concurrency ?? 4 }, worker));
  return out;
}

export { lock as lockFeed, unlock as unlockFeed };
