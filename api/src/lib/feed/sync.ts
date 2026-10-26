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
 * FEEDLOG#t / SYNC#<at>          sync runs that did something or failed (kept 90 days)
 * FEEDLOG#t / CHG#<at>#<eid>     one row per changed event (kept a year)
 * Both live outside the team's partition, so loading a team never reads them. When each team syncs is
 * lib/feed/schedule.ts.
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
import { isDue, soonDates } from "./schedule.js";
import { alertAdmins, flushHeld, NOTICE_FIELDS, notifyChanges, type FeedNotice } from "../comms/feed-notices.js";
import { openLink } from "./secret.js";
import { applyRules, FEED_OWNED, feedFields, FEED_KIND_LABELS, OVERRIDABLE, OVERRIDE_LABELS, type EventSource, type FeedFields, type FeedRules, type Overridable } from "../../shared/feed-rules.js";
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

/** Failed syncs in a row before admins get an email (about 3 hours on a busy day). */
export const FAILING_AFTER = 6;

export type SyncRun = {
  /** People emailed about cancelled or moved events by this run. */
  emailed?: number;
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

/** A sync that stops because the rules suddenly match far fewer events than last time. */
export function needsAttention(prevTotal: number | undefined, now: number): boolean {
  return !!prevTotal && prevTotal >= 6 && (now === 0 || now < prevTotal / 2);
}

/** What the calendar said last for each field (overridden fields keep the calendar's value in src). */
function lastFeedFields(e: Row): FeedFields {
  const f = currentFields(e);
  const s = e.src as EventSource;
  for (const [k, v] of Object.entries(s.ov ?? {})) {
    void v;
    const feed = s.conflict?.[k as Overridable] ?? s.ovBase?.[k as Overridable] ?? "";
    if (feed) f[k as Overridable] = feed; else delete f[k as Overridable];
  }
  return f;
}

type Plan = {
  added: Row[];
  updates: { old: Row & { eid: string }; f: FeedFields; s: EventSource; text: string; fields: Record<string, { was?: unknown; now?: unknown }> }[];
  missing: { eid: string; n: number; since: string }[];
  resets: string[];
  total: number;
  attention?: { was: number; now: number };
  /** Days with feed events in the next month (for when to sync next). */
  soon: string[];
};

/** Works out what a sync would do, without writing anything. */
async function plan(teamId: string, src: Source, from: string, at: string, by: string, body?: string): Promise<{ p: Plan; today: string }> {
  const rules = await currentRules(teamId, src.version);
  const zone = zoneOf(await getComms(teamId));
  const today = localParts(new Date(), zone).date;
  const text = body ?? (await loadFeed(await openLink(src.link, teamId))).body;
  const parsed = parseFeed(text, { teamZone: zone, windowStart: addDays(today, -400), windowEnd: addDays(today, 550) });
  const matched = applyRules(parsed.events, rules).matched.filter((m) => m.endDate >= from);
  const p: Plan = { added: [], updates: [], missing: [], resets: [], total: matched.length, soon: soonDates(matched, today, 30) };
  if (!src.attentionAck && needsAttention(Number(src.lastGoodTotal ?? 0) || undefined, matched.length)) {
    p.attention = { was: Number(src.lastGoodTotal), now: matched.length };
    return { p, today };
  }
  const { fromFeed } = await teamEvents(teamId);
  const seen = new Set<string>();
  for (const m of matched) {
    if (seen.has(m.uid)) continue;
    seen.add(m.uid);
    const f = feedFields(m);
    const old = fromFeed.get(m.uid);
    if (!old) {
      const eid = eidFor(m.uid);
      const { cancelled, ...fields } = f;
      p.added.push({
        ...keys.event(teamId, eid), type: "Event", ...fields, travel: false, ...(cancelled ? { cancelled: [f.date] } : {}),
        src: { uid: m.uid, fp: fingerprint(f, false), added: at, rulesV: src.version } satisfies EventSource,
        GSI2PK: `TEAM#${teamId}#CAL`, GSI2SK: `${f.date}#${eid}`, updatedAt: at, updatedBy: by
      });
      continue;
    }
    const s = old.src as EventSource;
    const kindSet = !!s.kindSet;
    const fp = fingerprint(f, kindSet);
    // Back after an admin kept or cancelled it while it was gone: written again even if nothing else changed.
    const back = !!(s.gone || s.keep);
    // Changed by hand while syncing was off (not an override): the calendar's value comes back.
    const drifted = FEED_OWNED.some((k) => !(k in (s.ov ?? {})) && String(old[k] ?? "") !== String(f[k] ?? ""));
    if (fp === s.fp && !back && !drifted) {
      if (s.missing) p.resets.push(old.eid);
      continue;
    }
    const was = fp === s.fp && drifted ? { ...currentFields(old), ...Object.fromEntries(Object.keys(s.ov ?? {}).map((k) => [k, f[k as Overridable]])) } as FeedFields : lastFeedFields(old);
    const text = fp === s.fp && back && !drifted ? (s.gone ? "back on" : "") : changeText(was, f, kindSet) || (s.gone ? "back on" : "");
    const fields: Record<string, { was?: unknown; now?: unknown }> = {};
    for (const k of [...FEED_OWNED, "cancelled", "kind"] as const) if ((was as Row)[k] !== (f as Row)[k] && !(k === "kind" && kindSet)) fields[k] = { was: (was as Row)[k], now: (f as Row)[k] };
    // Overridden fields: the admin's value stays; a calendar change to one is a conflict to review.
    const conflict: Partial<Record<Overridable, string>> = {};
    for (const k of Object.keys(s.ov ?? {}) as Overridable[]) {
      const feedNow = f[k] ?? "";
      if (feedNow !== (s.ovBase?.[k] ?? "")) conflict[k] = feedNow;
    }
    const { missing: _m, missingSince: _ms, keep: _k, gone: _g, conflict: _c, ...rest } = s;
    const next: EventSource = { ...rest, fp, rulesV: src.version, ...(text ? { change: { at, text } } : {}), ...(Object.keys(conflict).length ? { conflict } : {}) };
    p.updates.push({ old, f, s: next, text, fields });
  }
  // Events gone from the feed: counted, never removed here. Ones that already happened, or that an admin kept or cancelled, don't count.
  const missingNow: (Row & { eid: string })[] = [];
  for (const [uid, e] of fromFeed) {
    if (seen.has(uid)) continue;
    if (String(e.endDate || e.date) < today) continue;
    const s = e.src as EventSource;
    if (s.keep || s.gone) continue;
    p.missing.push({ eid: e.eid, n: (s.missing ?? 0) + 1, since: s.missingSince ?? at });
    missingNow.push(e);
  }
  // A new event with the same date, time and name as one that just went missing: probably the same one with a new id.
  for (const a of p.added) {
    const twin = missingNow.find((e) => e.date === a.date && (e.time ?? "") === (a.time ?? "") && String(e.title).toLowerCase() === String(a.title).toLowerCase());
    if (twin) (a.src as EventSource).dupOf = twin.eid;
  }
  return { p, today };
}

export type Preview = { added: { title: string; date: string }[]; changes: { eid: string; title: string; date: string; text: string }[]; missing: number; total: number; attention?: { was: number; now: number } };

/** What a sync would do now, for the catch-up after syncing was off. */
export async function previewSync(teamId: string): Promise<Preview> {
  const src = (await getItem(keys.feedSource(teamId))) as Source | undefined;
  if (!src?.importFrom) throw new FeedError("feed_not_imported", "Import the feed first.");
  const { p } = await plan(teamId, src, src.importFrom, new Date().toISOString(), "feed");
  return {
    added: p.added.map((a) => ({ title: String(a.title), date: String(a.date) })),
    changes: p.updates.filter((u) => u.text).map((u) => ({ eid: u.old.eid, title: String(u.f.title), date: String(u.f.date), text: u.text })),
    missing: p.missing.length, total: p.total, ...(p.attention ? { attention: p.attention } : {})
  };
}

/**
 * Reads the feed and brings the team's events in line with it. `importFrom` is where the schedule
 * starts taking feed events (set when the feed was imported); earlier events are left alone.
 */
export async function syncTeam(teamId: string, opt: { trigger: SyncRun["trigger"]; by: string; importFrom?: string }): Promise<SyncRun> {
  const started = Date.now();
  const at = new Date().toISOString();
  const run: SyncRun = { at, ok: false, trigger: opt.trigger, added: 0, changed: 0, unchanged: 0, missing: 0, total: 0, ms: 0, changes: [] };
  let src = (await getItem(keys.feedSource(teamId))) as Source | undefined;
  if (!src) throw new FeedError("feed_missing", "This team has no calendar feed.");
  if (!src.logsMoved) { await moveLogs(teamId); src = { ...src, logsMoved: true }; }
  const from = opt.importFrom ?? src.importFrom;
  if (!from) throw new FeedError("feed_not_imported", "Import the feed first.");
  let attention: Plan["attention"];
  let quiet = false;
  const notices: FeedNotice[] = [];
  const reviewNew: string[] = [];
  const keep: Row = {};
  try {
    // A calendar that hasn't changed since the last full sync needs nothing read or written, as long
    // as nothing is waiting on a sync to move along (events being counted as missing, a paused feed).
    const canSkip = opt.trigger !== "import" && !!(src.lastSync as Row | undefined)?.ok && !src.attention && !src.attentionAck && !Number(src.missingNow ?? 0)
      && !!src.fullAt && Date.now() - Date.parse(String(src.fullAt)) < 86400000;
    const link = await openLink(src.link, teamId);
    const got = await loadFeed(link, canSkip ? { etag: src.etag as string | undefined, lastModified: src.lastModified as string | undefined } : {});
    const hash = got.notModified ? String(src.bodyHash ?? "") : bodyHash(got.body, src.version, from);
    if (canSkip && (got.notModified || hash === src.bodyHash)) {
      quiet = true;
      run.total = run.unchanged = Number(src.lastGoodTotal ?? 0);
      run.ok = true;
      // Same calendar, but the site may have started sending validators: keep them for next time.
      if (!got.notModified && (got.etag ?? null) !== (src.etag ?? null)) keep.etag = got.etag ?? null;
      if (!got.notModified && (got.lastModified ?? null) !== (src.lastModified ?? null)) keep.lastModified = got.lastModified ?? null;
    } else {
      const body = got.notModified ? (await loadFeed(link)).body : got.body;
      const { p } = await plan(teamId, src, from, at, opt.by, body);
      run.total = p.total;
      if (p.attention) {
        attention = p.attention;
        throw new FeedError("feed_attention", `The rules matched ${p.attention.now} events this time, down from ${p.attention.was}. The club may have renamed the team or changed systems, so syncing is paused until an admin checks the rules. Nothing on the schedule changed.`);
      }
      const chgRows: Row[] = [];
      for (const u of p.updates) {
        await writeChange(teamId, u.old, u.f, !!u.s.kindSet, u.s, at, opt.by);
        const was = u.old.src as EventSource;
        // An override the calendar has just changed under: on the review list.
        for (const [k, v] of Object.entries(u.s.conflict ?? {})) if (was.conflict?.[k as Overridable] !== v) {
          reviewNew.push(`${shortDate(String(u.f.date))} · ${u.f.title}: the calendar now has ${v || `no ${OVERRIDE_LABELS[k as Overridable]}`}; the team's override says ${u.s.ov?.[k as Overridable] || "nothing"}`);
        }
        if (u.text) {
          run.changed++;
          const reason = (u.old.src as EventSource).rulesV !== src.version ? "rules" : "feed";
          // Families hear about cancellations and new days, times, places and courts, not renames or new rules.
          const touched = Object.keys(u.fields).filter((k) => (NOTICE_FIELDS as readonly string[]).includes(k) && !(k in (u.s.ov ?? {})));
          if (reason === "feed" && touched.length) {
            const eff = (k: Overridable) => (u.s.ov?.[k] ?? u.f[k]) || undefined;
            // Worded from the fields families will see change, not the ones the team overrode or renames.
            const before = { ...u.f } as FeedFields;
            for (const k of touched) (before as Row)[k] = u.fields[k].was;
            notices.push({ eid: u.old.eid, title: String(u.f.title), date: String(u.f.date), ...(u.fields.date ? { wasDate: String(u.fields.date.was ?? "") } : {}),
              text: changeText(before, u.f, true) || u.text, cancelled: !!u.f.cancelled, fields: touched, time: eff("time"), endTime: eff("endTime"), location: eff("location"), court: eff("court") });
          }
          chgRows.push({ ...keys.feedLog(teamId, `CHG#${at}#${u.old.eid}`), type: "FeedChange", eid: u.old.eid, at, title: u.f.title, date: u.f.date, text: u.text, fields: JSON.parse(JSON.stringify(u.fields)), reason, ttl: Math.floor(Date.now() / 1000) + 365 * DAY });
          run.changes.push({ eid: u.old.eid, title: String(u.f.title), date: String(u.f.date), text: u.text });
        } else run.unchanged++;
      }
      run.unchanged += p.total - p.added.length - p.updates.length;
      for (const eid of p.resets) await setMissing(teamId, eid, 0);
      for (const m of p.missing) await setMissing(teamId, m.eid, m.n, m.since);
      run.missing = p.missing.length;
      run.added = p.added.length;
      for (const m of p.missing.filter((x) => x.n === 2)) {
        const e = await getItem(keys.event(teamId, m.eid));
        if (e) reviewNew.push(`${shortDate(String(e.date))} · ${e.title}: not on the club's calendar any more (cancel it or keep it)`);
      }
      for (const a of p.added.filter((x) => (x.src as EventSource).dupOf)) reviewNew.push(`${shortDate(String(a.date))} · ${a.title}: looks like a new copy of an event that disappeared (merge them or keep both)`);
      await putMany(p.added);
      await putMany(chgRows);
      run.ok = true;
      Object.assign(keep, { soon: p.soon, fullAt: at, bodyHash: hash, missingNow: p.missing.length, etag: got.etag ?? null, lastModified: got.lastModified ?? null });
    }
  } catch (e) {
    run.error = e instanceof FeedError ? e.message : "Something went wrong reading the feed.";
    run.code = e instanceof FeedError ? e.code : "error";
    if (!(e instanceof FeedError)) console.error(JSON.stringify({ msg: "feed sync error", teamId, error: String(e), stack: (e as Error)?.stack }));
  }
  run.ms = Date.now() - started;
  const { changes, ...summary } = run;
  // Quiet runs of the job leave no row: the feed's "last synced" says enough.
  const worthKeeping = !run.ok || run.trigger !== "job" || run.added > 0 || run.changed > 0 || (!quiet && run.missing > Number(src.missingNow ?? 0));
  if (worthKeeping) await putItem({ ...keys.feedLog(teamId, `SYNC#${at}`), type: "FeedSync", ...summary, changes: changes.slice(0, 20), ttl: Math.floor(Date.now() / 1000) + 90 * DAY });
  const extra = Object.entries(keep);
  const sets = extra.map(([k], i) => `#k${i} = :k${i}`).join(", ");
  const kNames = Object.fromEntries(extra.map(([k], i) => [`#k${i}`, k]));
  const kValues = Object.fromEntries(extra.map(([, v], i) => [`:k${i}`, v]));
  const upd = run.ok
    ? { e: `SET lastSync = :s, lastOkAt = :at, failures = :zero, lastGoodTotal = :n${sets ? `, ${sets}` : ""} REMOVE attention, attentionAck`, v: { ":s": summary, ":at": at, ":zero": 0, ":n": run.total, ...kValues }, n: kNames }
    : attention
      ? { e: "SET lastSync = :s, attention = :a", v: { ":s": summary, ":a": { at: src.attention ? (src.attention as Row).at : at, ...attention } }, n: {} }
      : { e: "SET lastSync = :s ADD failures :one", v: { ":s": summary, ":one": 1 }, n: {} };
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.feedSource(teamId), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: upd.e, ExpressionAttributeValues: upd.v, ...(Object.keys(upd.n).length ? { ExpressionAttributeNames: upd.n } : {})
  })).catch((e) => console.error(JSON.stringify({ msg: "feed source not updated", teamId, error: String(e) })));
  // C4: tell families about changes coming up, and the team's admins about what needs them.
  try {
    const clubId = await clubOfTeam(teamId);
    if (notices.length) run.emailed = (await notifyChanges(teamId, clubId, notices, `${teamId}:${at}`)).emailed;
    if (reviewNew.length) await alertAdmins(teamId, clubId, { kind: "review", items: reviewNew }, `review:${teamId}:${at}`);
    if (attention && !src.attention) await alertAdmins(teamId, clubId, { kind: "attention", items: [], detail: `The rules matched ${attention.now} events this time, down from ${attention.was}. The club may have renamed the team or changed systems.` }, `attention:${teamId}:${at}`);
    if (!run.ok && !attention && Number(src.failures ?? 0) + 1 === FAILING_AFTER) {
      await alertAdmins(teamId, clubId, { kind: "failing", items: [], detail: `The last ${FAILING_AFTER} tries failed: ${run.error ?? "the calendar couldn't be read"}` }, `failing:${teamId}:${String(src.lastOkAt ?? "")}`);
    }
  } catch (e) { console.error(JSON.stringify({ msg: "feed notices failed", teamId, error: String(e) })); }
  console.log(JSON.stringify({ msg: "feed synced", teamId, trigger: run.trigger, ok: run.ok, quiet, added: run.added, changed: run.changed, missing: run.missing, total: run.total, ms: run.ms, code: run.code }));
  return run;
}

/**
 * Fingerprint of a calendar file for "has it changed?". Lines feeds rewrite on every fetch without
 * anything changing (DTSTAMP, and SEQUENCE in Sprocket's) are left out; the rules version and the
 * import date are in, so new rules always get a full sync.
 */
export function bodyHash(body: string, rulesVersion: number, from: string): string {
  const lines = body.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((l) => !/^(DTSTAMP|SEQUENCE|LAST-MODIFIED|CREATED)[;:]/i.test(l));
  return createHash("sha256").update(`${rulesVersion}|${from}|${lines.join("\n")}`).digest("base64url").slice(0, 22);
}

/** Sync logs written before they had their own partition move there once (C3 kept them in the team's). */
async function moveLogs(teamId: string) {
  const old = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": "FEED#" } });
  const logs = old.filter((r) => String(r.SK).startsWith("FEED#SYNC#") || String(r.SK).startsWith("FEED#CHG#"));
  const sync = logs.filter((r) => String(r.SK).startsWith("FEED#SYNC#")).sort((a, b) => String(b.SK).localeCompare(String(a.SK)));
  // Every change row, and the sync rows that did something (or the latest few), move across.
  const keepSync = sync.filter((r, i) => i < 8 || !r.ok || Number(r.added) || Number(r.changed));
  const moved = [...logs.filter((r) => String(r.SK).startsWith("FEED#CHG#")), ...keepSync].map(({ PK: _p, SK, ...rest }) => ({ ...rest, ...keys.feedLog(teamId, String(SK).slice(5)) }));
  await putMany(moved);
  await deleteMany(logs.map((r) => ({ PK: String(r.PK), SK: String(r.SK) })));
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.feedSource(teamId), UpdateExpression: "SET logsMoved = :t", ConditionExpression: "attribute_exists(PK)", ExpressionAttributeValues: { ":t": true } })).catch(() => undefined);
  if (logs.length) console.log(JSON.stringify({ msg: "feed logs moved", teamId, rows: logs.length, kept: moved.length }));
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
  const values: Record<string, unknown> = { ":src": JSON.parse(JSON.stringify(s)), ":at": at, ":by": by, ":g": `${f.date}#${old.eid}` };
  for (const k of FEED_OWNED) {
    names[`#${k}`] = k;
    const v = k in (s.ov ?? {}) ? s.ov![k as Overridable] : f[k];
    if (v) { sets.push(`#${k} = :${k}`); values[`:${k}`] = v; } else removes.push(`#${k}`);
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

// ---------- Overrides and review ----------

const chgRow = (teamId: string, eid: string, e: Row, text: string, reason: string, by: string) => ({
  ...keys.feedLog(teamId, `CHG#${new Date().toISOString()}#${eid}`), type: "FeedChange", eid, at: new Date().toISOString(),
  title: e.title, date: e.date, text, reason, by, ttl: Math.floor(Date.now() / 1000) + 365 * DAY
});

async function feedEvent(teamId: string, eid: string): Promise<Row & { src: EventSource }> {
  const e = await getItem(keys.event(teamId, eid));
  if (!e?.src) throw new FeedError("feed_not_feed_event", "That event isn't from the club's calendar.");
  return e as Row & { src: EventSource };
}

async function saveEvent(teamId: string, eid: string, set: Row, remove: string[], src: EventSource, by: string) {
  const names: Record<string, string> = { "#src": "src" };
  const values: Record<string, unknown> = { ":src": JSON.parse(JSON.stringify(src)), ":at": new Date().toISOString(), ":by": by };
  const sets = ["#src = :src", "updatedAt = :at", "updatedBy = :by"];
  Object.entries(set).forEach(([k, v], i) => { names[`#f${i}`] = k; values[`:f${i}`] = v; sets.push(`#f${i} = :f${i}`); });
  const rem = remove.map((k, i) => { names[`#r${i}`] = k; return `#r${i}`; });
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.event(teamId, eid), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: `SET ${sets.join(", ")}${rem.length ? ` REMOVE ${rem.join(", ")}` : ""}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values
  }));
}

const label = (k: Overridable) => OVERRIDE_LABELS[k];

/** Sets (or, with null, clears) an admin's own values for some of the calendar's fields on one event. */
export async function setOverrides(teamId: string, eid: string, ov: Partial<Record<Overridable, string | null>>, by: string) {
  const e = await feedEvent(teamId, eid);
  const s: EventSource = { ...e.src, ov: { ...(e.src.ov ?? {}) }, ovBase: { ...(e.src.ovBase ?? {}) }, conflict: { ...(e.src.conflict ?? {}) } };
  const set: Row = {}, remove: string[] = [], said: string[] = [];
  for (const [k, raw] of Object.entries(ov) as [Overridable, string | null][]) {
    if (!OVERRIDABLE.includes(k)) continue;
    const had = k in s.ov!;
    const feedNow = had ? (s.conflict![k] ?? s.ovBase![k] ?? "") : String(e[k] ?? "");
    const v = raw === null ? null : raw.trim();
    if (v === null || v === feedNow) {
      if (!had) continue;
      delete s.ov![k]; delete s.ovBase![k]; delete s.conflict![k];
      if (feedNow) set[k] = feedNow; else remove.push(k);
      said.push(`${label(k)} back to the calendar's${feedNow ? ` (${feedNow})` : ""}`);
      continue;
    }
    if (!had) s.ovBase![k] = feedNow;
    s.ov![k] = v;
    delete s.conflict![k];
    if (v) set[k] = v; else remove.push(k);
    said.push(`${label(k)} set to ${v || "nothing"}${feedNow ? ` (the calendar has ${feedNow})` : ""}`);
  }
  for (const k of ["ov", "ovBase", "conflict"] as const) if (!Object.keys(s[k] ?? {}).length) delete s[k];
  if (!said.length) return;
  await saveEvent(teamId, eid, set, remove, s, by);
  await putItem(chgRow(teamId, eid, e, said.join("; "), "override", by));
}

export type ReviewAction =
  | { action: "cancel" | "keep" | "merge" | "different"; eid: string }
  | { action: "useFeed" | "keepMine"; eid: string; field: Overridable };

/** Settles one item on the review list. */
export async function settleReview(teamId: string, b: ReviewAction, by: string): Promise<{ eid: string }> {
  const e = await feedEvent(teamId, b.eid);
  const { missing: _m, missingSince: _ms, ...s } = e.src;
  switch (b.action) {
    case "cancel":
      await saveEvent(teamId, b.eid, { cancelled: [String(e.date)] }, [], { ...s, gone: true, change: { at: new Date().toISOString(), text: "cancelled" } }, by);
      await putItem(chgRow(teamId, b.eid, e, "cancelled: it's gone from the club's calendar", "review", by));
      await notifyChanges(teamId, await clubOfTeam(teamId), [{ eid: b.eid, title: String(e.title), date: String(e.date), text: "cancelled", cancelled: true, fields: ["cancelled"] }], `review:${b.eid}:${String(e.date)}`)
        .catch((err) => console.error(JSON.stringify({ msg: "feed notice failed", teamId, error: String(err) })));
      return { eid: b.eid };
    case "keep":
      await saveEvent(teamId, b.eid, {}, [], { ...s, keep: true }, by);
      await putItem(chgRow(teamId, b.eid, e, "kept, though it's gone from the club's calendar", "review", by));
      return { eid: b.eid };
    case "different": {
      const { dupOf: _d, ...rest } = s;
      await saveEvent(teamId, b.eid, {}, [], rest, by);
      return { eid: b.eid };
    }
    case "useFeed":
      await setOverrides(teamId, b.eid, { [b.field]: null }, by);
      return { eid: b.eid };
    case "keepMine": {
      const v = s.conflict?.[b.field];
      if (v === undefined) return { eid: b.eid };
      const conflict = { ...(s.conflict ?? {}) }; delete conflict[b.field];
      const next: EventSource = { ...s, ovBase: { ...(s.ovBase ?? {}), [b.field]: v }, conflict };
      if (!Object.keys(conflict).length) delete next.conflict;
      await saveEvent(teamId, b.eid, {}, [], next, by);
      await putItem(chgRow(teamId, b.eid, e, `kept the team's ${label(b.field)} (${s.ov?.[b.field] || "nothing"}); the calendar has ${v || "nothing"}`, "override", by));
      return { eid: b.eid };
    }
    case "merge": {
      // The new entry is the old event under a new id: the old event (with its answers, attendance, meals and
      // ref jobs) takes the new id and the calendar's current details, and the new entry goes.
      if (!s.dupOf) throw new FeedError("feed_not_duplicate", "That event isn't marked as a possible duplicate.");
      const old = await feedEvent(teamId, s.dupOf);
      const os = old.src;
      const f = currentFields(e);
      const set: Row = { cancelled: f.cancelled ? [f.date] : [] }, remove: string[] = [];
      for (const k of FEED_OWNED) {
        const v = k in (os.ov ?? {}) ? os.ov![k as Overridable] : f[k];
        if (v) set[k] = v; else remove.push(k);
      }
      if (!os.kindSet) set.kind = f.kind;
      const { missing: _om, missingSince: _oms, keep: _ok, gone: _og, ...orest } = os;
      await saveEvent(teamId, s.dupOf, { ...set, GSI2SK: `${f.date}#${s.dupOf}` }, remove, { ...orest, uid: s.uid, fp: s.fp, rulesV: s.rulesV }, by);
      // Anything families already put on the new entry moves to the old event, unless it has its own.
      const families = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :f)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":f": "FAMILY#" } });
      for (const fam of families) {
        const rsvp = { ...((fam.rsvp ?? {}) as Row) };
        if (!rsvp[b.eid]) continue;
        if (!rsvp[s.dupOf]) rsvp[s.dupOf] = rsvp[b.eid];
        delete rsvp[b.eid];
        await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { PK: String(fam.PK), SK: String(fam.SK) }, UpdateExpression: "SET rsvp = :r", ExpressionAttributeValues: { ":r": rsvp } }));
      }
      const att = await getItem(keys.attendance(teamId, b.eid));
      if (att && !(await getItem(keys.attendance(teamId, s.dupOf)))) { const { PK: _p, SK: _s, ...rest } = att; await putItem({ ...keys.attendance(teamId, s.dupOf), ...rest, key: s.dupOf }); }
      const children = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": `EVENT#${b.eid}#` }, ProjectionExpression: "PK, SK" });
      await deleteMany([keys.event(teamId, b.eid), keys.attendance(teamId, b.eid), ...(children as { PK: string; SK: string }[])]);
      await putItem(chgRow(teamId, s.dupOf, { ...old, ...set }, "matched to its new entry in the club's calendar", "review", by));
      return { eid: s.dupOf };
    }
  }
}

/** Syncing was turned off: the job and the team switch both mark it, so turning it back on shows a catch-up first. */
export async function markPaused(teamId: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.feedSource(teamId), ConditionExpression: "attribute_exists(importedAt)",
    UpdateExpression: "SET pausedSince = if_not_exists(pausedSince, :at)", ExpressionAttributeValues: { ":at": new Date().toISOString() }
  })).catch(() => undefined);
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
  const log = await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `FEEDLOG#${teamId}` }, ProjectionExpression: "PK, SK" });
  await deleteMany([...items, ...log].map((i) => ({ PK: String(i.PK), SK: String(i.SK) })));
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

/**
 * Every 10 minutes (template.yaml FeedSyncFunction): syncs the imported feeds that are due
 * (lib/feed/schedule.ts) and whose team and club allow it. `due: false` syncs every feed now (tests).
 */
export async function runFeedSync(opt: { concurrency?: number; at?: Date; due?: boolean } = {}) {
  const sources = await queryAll({ IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :g", ExpressionAttributeValues: { ":g": "FEEDS" } });
  const out = { teams: sources.length, synced: 0, skipped: 0, failed: 0, notDue: 0 };
  const queue = sources.map((s) => String(s.GSI2SK));
  const worker = async () => {
    for (let teamId = queue.shift(); teamId; teamId = queue.shift()) {
      try {
        const clubId = await clubOfTeam(teamId);
        const [controls, dir, settings] = await Promise.all([getControls(clubId), getItem(keys.teamDir(clubId, teamId)), getItem(keys.settings(teamId))]);
        if (!isActive(controls) || dir?.archived) { out.skipped++; continue; }
        if (!isOn(effectiveFeatures(settings?.features as FeatureMap, controls.features), "calfeed")) { await markPaused(teamId); out.skipped++; continue; }
        const src = await getItem(keys.feedSource(teamId));
        // Back on after a pause: an admin looks over what changed first (Calendar feed › Catch up).
        if (src?.noticesHeld) await flushHeld(teamId, clubId).catch((e) => console.error(JSON.stringify({ msg: "held notices failed", teamId, error: String(e) })));
        if (src?.pausedSince) { out.skipped++; continue; }
        if (opt.due !== false && !isDue({ teamId, at: opt.at ?? new Date(), zone: zoneOf(await getComms(teamId)), soon: (src?.soon as string[] | undefined) ?? [], lastAttemptAt: (src?.lastSync as Row | undefined)?.at as string | undefined })) { out.notDue++; continue; }
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
