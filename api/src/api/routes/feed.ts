/**
 * Calendar feed sync, stage C1: a team admin or coordinator pastes the team's calendar link once,
 * checks what's in it, sets the import rules and saves both. The link is stored encrypted
 * (lib/feed/secret.ts) and never sent back or logged; screens show a masked form. Nothing is written
 * to the schedule here; importing and the regular sync are in lib/feed/sync.ts (stage C2).
 *
 * TEAM#t / FEED#SOURCE        the link (sealed), its host, masked form, preset and rules version
 * TEAM#t / FEED#RULES#0001…   every version of the rules, with who saved it and a note
 * TEAM#t / FEED#CHECKS        recent Check feed times (a few a minute at most)
 */
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { getComms, zoneOf } from "../../lib/comms/planner.js";
import { localParts } from "../../lib/comms/zoned.js";
import { addDays, FeedError, parseFeed, type ParsedFeed } from "../../lib/feed/ical.js";
import { loadFeed, maskFeedUrl } from "../../lib/feed/fetch.js";
import { openLink, sealLink } from "../../lib/feed/secret.js";
import { applyRules, describeFilter, detectPreset, FEED_KINDS, PRESETS, sameRules, startingRules, suggestFilters, type FeedRules, type PresetId } from "../../shared/feed-rules.js";
import { loadAccess, type TeamAccess } from "../context.js";
import { HttpError, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, date, getItem, now, putItem, queryAll } from "../util.js";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { disconnect, importFeed, lockFeed, MANUAL_EVERY_MS, syncTeam, unlockFeed } from "../../lib/feed/sync.js";

const kind = z.enum(FEED_KINDS);
const text = (max: number) => z.string().trim().min(1).max(max);
export const rulesSchema = z.object({
  filter: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }),
    z.object({ mode: z.enum(["prefix", "contains"]), text: text(80) })
  ]),
  stripFilter: z.boolean(),
  strip: z.array(text(80)).max(5),
  types: z.array(z.discriminatedUnion("when", [
    z.object({ when: z.literal("title"), text: text(60), kind }),
    z.object({ when: z.literal("category"), text: text(60), kind }),
    z.object({ when: z.literal("allDay"), kind }),
    z.object({ when: z.literal("longer"), hours: z.number().min(1).max(96), kind })
  ])).max(12),
  fallback: kind,
  court: z.object({ from: z.enum(["description", "location", "none"]), label: z.string().trim().max(20) }),
  venue: z.enum(["firstLine", "whole"]),
  preset: z.enum(Object.keys(PRESETS) as [PresetId, ...PresetId[]]).optional()
});

const importSchema = z.object({
  /** The schedule takes feed events that end on or after this date. */
  from: date,
  /** Hand-entered practices from this date on give way to the feed's (answers and attendance move over). */
  replaceFrom: date.nullable().optional()
});
const checkSchema = z.object({ url: z.string().trim().min(8).max(2000).optional() });
const saveSchema = z.object({
  /** Needed the first time, and to change the link; left out to keep the saved one. */
  url: z.string().trim().min(8).max(2000).optional(),
  rules: rulesSchema,
  note: z.string().trim().max(200).optional()
});

type Source = Record<string, unknown> & {
  link: string; host: string; masked: string; preset: PresetId; version: number;
  savedAt: string; savedBy: string; calendarName?: string;
  lastCheck?: { at: string; total: number; matched: number };
};
type RulesVersion = { v: number; rules: FeedRules; at: string; by: string; note?: string; summary: string };

const CHECKS = { perWindow: 6, windowMs: 60_000 };

function toHttp(e: unknown): never {
  if (e instanceof FeedError) throw new HttpError(e.code === "feed_bad_link" ? 400 : 422, e.message, e.code);
  throw e;
}

async function access(caller: { sub: string; username: string }, teamId: string, write: boolean): Promise<TeamAccess> {
  const a = await loadAccess(caller, checkId(teamId, "team"));
  a.require("calendarFeed");
  if (write) a.requireFeature("calfeed");
  return a;
}

/** A few checks a minute per team: each one fetches the club's calendar. */
async function rateLimit(teamId: string) {
  const k = keys.feedChecks(teamId);
  const t = Date.now();
  const recent = (((await getItem(k))?.times ?? []) as number[]).filter((x) => t - x < CHECKS.windowMs);
  if (recent.length >= CHECKS.perWindow) throw new HttpError(429, "That's a lot of checks in a minute. Wait a moment and try again.", "feed_rate_limited");
  await putItem({ ...k, type: "FeedChecks", times: [...recent, t], ttl: Math.floor(t / 1000) + 3600 });
}

async function readFeed(link: string, teamId: string): Promise<{ parsed: ParsedFeed; host: string; zone: string }> {
  const zone = zoneOf(await getComms(teamId));
  const today = localParts(new Date(), zone).date;
  try {
    const got = await loadFeed(link);
    const parsed = parseFeed(got.body, { teamZone: zone, windowStart: addDays(today, -400), windowEnd: addDays(today, 550) });
    return { parsed, host: got.host, zone };
  } catch (e) { toHttp(e); }
}

async function versions(teamId: string): Promise<RulesVersion[]> {
  const items = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": "FEED#RULES#" }, ScanIndexForward: false });
  return items.map((i) => ({ v: Number(i.v), rules: i.rules as FeedRules, at: String(i.at), by: String(i.by), note: i.note as string | undefined, summary: String(i.summary ?? "") }));
}

/** What the panel shows: never the link itself. */
async function view(teamId: string) {
  const src = (await getItem(keys.feedSource(teamId))) as Source | undefined;
  if (!src) return { connected: false as const };
  const all = await versions(teamId);
  const current = all.find((x) => x.v === src.version) ?? all[0];
  const runs = src.importedAt ? await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": "FEED#SYNC#" }, ScanIndexForward: false, Limit: 8 }) : [];
  return {
    connected: true as const,
    source: {
      host: src.host, masked: src.masked, preset: src.preset, presetLabel: PRESETS[src.preset]?.label ?? "", calendarName: src.calendarName ?? "", savedAt: src.savedAt, savedBy: src.savedBy, lastCheck: src.lastCheck ?? null,
      importedAt: src.importedAt ?? null, importFrom: src.importFrom ?? null, lastSync: src.lastSync ?? null, lastOkAt: src.lastOkAt ?? null, failures: src.failures ?? 0,
      nextManualAt: src.manualAt ? new Date(Number(src.manualAt) + MANUAL_EVERY_MS).toISOString() : null
    },
    version: current?.v ?? 0,
    rules: current?.rules ?? null,
    history: all.slice(0, 20).map(({ rules: _r, ...h }) => h),
    runs: runs.slice(0, 8).map((r) => ({ at: r.at, ok: r.ok, trigger: r.trigger, added: r.added, changed: r.changed, unchanged: r.unchanged, missing: r.missing, total: r.total, error: r.error, changes: r.changes ?? [] }))
  };
}

export function feedRoutes(r: Router) {
  r.on("GET", "/teams/{teamId}/feed", async ({ caller, params }) => {
    const a = await access(caller, params.teamId, false);
    return json(200, await view(a.teamId));
  });

  /** Fetches and reads the feed (a new link, or the saved one) without saving anything. */
  r.on("POST", "/teams/{teamId}/feed/check", async ({ caller, params, body }) => {
    const a = await access(caller, params.teamId, true);
    const b = parseBody(checkSchema, body);
    const src = (await getItem(keys.feedSource(a.teamId))) as Source | undefined;
    if (!b.url && !src) throw new HttpError(400, "Paste the team's calendar link first.", "bad_request");
    await rateLimit(a.teamId);
    const link = b.url ?? (await openLink(src!.link, a.teamId));
    const { parsed, host, zone } = await readFeed(link, a.teamId);
    const preset = detectPreset({ prodid: parsed.prodid, host, uids: parsed.events.slice(0, 50).map((e) => e.uid) });
    const saved = src && !b.url ? (await versions(a.teamId)).find((x) => x.v === src.version)?.rules : undefined;
    console.log(JSON.stringify({ msg: "feed checked", teamId: a.teamId, by: caller.sub, host, preset, events: parsed.events.length, newLink: !!b.url }));
    return json(200, {
      calendar: { name: parsed.name, prodid: parsed.prodid.slice(0, 120), zone: parsed.zone || zone, teamZone: zone, total: parsed.events.length, from: parsed.from, to: parsed.to, warnings: parsed.warnings },
      host, masked: maskFeedUrl(link), preset, presetLabel: PRESETS[preset].label,
      suggestions: suggestFilters(parsed.events),
      rules: saved ?? startingRules(preset, parsed.events),
      events: parsed.events
    });
  });

  /** Saves the link (first time or a new one) and the rules. A rules change makes a new version. */
  r.on("PUT", "/teams/{teamId}/feed", async ({ caller, params, body }) => {
    const a = await access(caller, params.teamId, true);
    const b = parseBody(saveSchema, body);
    const rules = b.rules as FeedRules;
    const src = (await getItem(keys.feedSource(a.teamId))) as Source | undefined;
    if (!b.url && !src) throw new HttpError(400, "Paste the team's calendar link first.", "bad_request");
    // A new link is read once more before it's saved, so a typo never gets stored.
    let host = src?.host ?? "", masked = src?.masked ?? "", calendarName = src?.calendarName, lastCheck = src?.lastCheck, preset = src?.preset ?? rules.preset ?? "generic";
    let sealed = src?.link ?? "";
    if (b.url) {
      await rateLimit(a.teamId);
      const read = await readFeed(b.url, a.teamId);
      host = read.host; masked = maskFeedUrl(b.url); calendarName = read.parsed.name || undefined;
      preset = detectPreset({ prodid: read.parsed.prodid, host, uids: read.parsed.events.slice(0, 50).map((e) => e.uid) });
      const res = applyRules(read.parsed.events, rules);
      lastCheck = { at: now(), total: read.parsed.events.length, matched: res.matched.length };
      sealed = await sealLink(b.url, a.teamId);
    }
    const all = await versions(a.teamId);
    const current = all.find((x) => x.v === src?.version) ?? all[0];
    const changed = !current || !sameRules(current.rules, rules);
    const v = changed ? (all[0]?.v ?? 0) + 1 : current!.v;
    const at = now();
    // Keep what the import and the sync keep on the source (when it was imported, the last sync).
    const { lockUntil: _l, ...kept } = (src ?? {}) as Record<string, unknown>;
    const item: Source = {
      ...kept, ...keys.feedSource(a.teamId), type: "FeedSource", link: sealed, host, masked, preset, version: v,
      savedAt: at, savedBy: caller.sub, ...(calendarName ? { calendarName } : {}), ...(lastCheck ? { lastCheck } : {})
    };
    const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [{ Put: { TableName: TABLE, Item: item } }];
    if (changed) writes.push({ Put: {
      TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)",
      Item: { ...keys.feedRules(a.teamId, v), type: "FeedRules", v, rules, at, by: caller.sub, summary: describeFilter(rules.filter), ...(b.note ? { note: b.note } : {}) }
    } });
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
    } catch (e) {
      if ((e as { name?: string }).name === "TransactionCanceledException") throw new HttpError(409, "Someone else saved the rules at the same moment. Reload and try again.", "conflict");
      throw e;
    }
    console.log(JSON.stringify({ msg: "feed saved", teamId: a.teamId, by: caller.sub, host, preset, version: v, newLink: !!b.url, rulesChanged: changed }));
    return json(200, await view(a.teamId));
  });

  /** Goes back to an earlier version of the rules (as a new version, so the history stays whole). */
  r.on("POST", "/teams/{teamId}/feed/rules/{v}/restore", async ({ caller, params }) => {
    const a = await access(caller, params.teamId, true);
    const src = (await getItem(keys.feedSource(a.teamId))) as Source | undefined;
    if (!src) throw notFound("This team has no calendar feed.");
    const all = await versions(a.teamId);
    const old = all.find((x) => String(x.v) === params.v);
    if (!old) throw notFound("That version of the rules isn't there any more.");
    const v = (all[0]?.v ?? 0) + 1, at = now();
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: { ...keys.feedRules(a.teamId, v), type: "FeedRules", v, rules: old.rules, at, by: caller.sub, summary: describeFilter(old.rules.filter), note: `Back to version ${old.v}` } } },
      { Update: { TableName: TABLE, Key: keys.feedSource(a.teamId), UpdateExpression: "SET version = :v, savedAt = :at, savedBy = :by", ConditionExpression: "attribute_exists(PK)", ExpressionAttributeValues: { ":v": v, ":at": at, ":by": caller.sub } } }
    ] }));
    console.log(JSON.stringify({ msg: "feed rules restored", teamId: a.teamId, by: caller.sub, from: old.v, version: v }));
    return json(200, await view(a.teamId));
  });

  /** Disconnect: forgets the link and every version of the rules. (Allowed with the feature off, so a team can clean up.) */
  r.on("DELETE", "/teams/{teamId}/feed", async ({ caller, params }) => {
    const a = await access(caller, params.teamId, false);
    const { kept } = await disconnect(a.teamId);
    console.log(JSON.stringify({ msg: "feed disconnected", teamId: a.teamId, by: caller.sub, eventsKept: kept }));
    return json(200, { connected: false, eventsKept: kept });
  });

  /** First import: the feed's events go onto the schedule, and the sync every 30 minutes starts. */
  r.on("POST", "/teams/{teamId}/feed/import", async ({ caller, params, body }) => {
    const a = await access(caller, params.teamId, true);
    a.require("schedule");
    const b = parseBody(importSchema, body);
    const src = (await getItem(keys.feedSource(a.teamId))) as Source | undefined;
    if (!src) throw notFound("Save the team's calendar link first.");
    if (src.importedAt) throw new HttpError(409, "This feed is already on the schedule. It syncs on its own; use Sync now to check it straight away.", "feed_imported");
    if (b.replaceFrom && b.replaceFrom < b.from) throw new HttpError(400, "Replace practices from a date on or after the import starts.", "bad_request");
    if (!(await lockFeed(a.teamId))) throw new HttpError(409, "The feed is syncing right now. Try again in a minute.", "feed_busy");
    try {
      const { run, replaced } = await importFeed(a.teamId, { from: b.from, replaceFrom: b.replaceFrom ?? null, by: caller.sub });
      if (!run.ok) throw new HttpError(422, run.error ?? "Couldn't read the feed.", run.code ?? "feed_error");
      return json(200, { run: { ...run, changes: undefined }, replaced, feed: await view(a.teamId) });
    } finally { await unlockFeed(a.teamId); }
  });

  /** Sync now: at most once every 5 minutes per team. */
  r.on("POST", "/teams/{teamId}/feed/sync", async ({ caller, params }) => {
    const a = await access(caller, params.teamId, true);
    const src = (await getItem(keys.feedSource(a.teamId))) as Source | undefined;
    if (!src?.importedAt) throw new HttpError(409, "Import the feed onto the schedule first.", "feed_not_imported");
    const t = Date.now();
    if (src.manualAt && t - Number(src.manualAt) < MANUAL_EVERY_MS) {
      const mins = Math.ceil((Number(src.manualAt) + MANUAL_EVERY_MS - t) / 60000);
      throw new HttpError(429, `It synced a moment ago. Sync now works again in ${mins} minute${mins === 1 ? "" : "s"}.`, "feed_rate_limited");
    }
    if (!(await lockFeed(a.teamId))) throw new HttpError(409, "The feed is syncing right now. Try again in a minute.", "feed_busy");
    try {
      await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.feedSource(a.teamId), UpdateExpression: "SET manualAt = :t", ExpressionAttributeValues: { ":t": t } }));
      const run = await syncTeam(a.teamId, { trigger: "manual", by: caller.sub });
      return json(200, { run, feed: await view(a.teamId) });
    } finally { await unlockFeed(a.teamId); }
  });
}
