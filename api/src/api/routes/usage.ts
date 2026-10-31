/**
 * Site usage (site admin › Usage and Health). The site reports each page it opens, and the API counts
 * requests and actions as they happen (handler.ts); lib/usage.ts keeps the totals. Site owners see
 * totals only: nothing here says which person did what.
 */
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { clubOfTeam, DEFAULT_CLUB, getClubs } from "../../lib/clubs.js";
import { getControlsMany } from "../../lib/club-controls.js";
import { isExpired } from "../../lib/invites.js";
import { buildItems } from "../../lib/comms/schedule.js";
import {
  countAction, countBrowserError, countView, dailyRows, noteRelease, plusDays, quietly, releases, seenRows, stamp, weekOf, weeklyRows, type Row
} from "../../lib/usage.js";
import { effectiveFeatures, isOn, type Feature, type FeatureMap } from "../../shared/features.js";
import {
  ACTION_LABELS, ACTIONS, AREA_LABELS, AREAS, DEVICES, LOAD_BUCKETS, p95, PUBLIC_AREAS, SOURCE_LABELS, SOURCES, TEAM_AREAS,
  type Action, type Area, type Period, type TeamArea
} from "../../shared/usage.js";
import { requirePlatformAdmin } from "../context.js";
import { badRequest, json } from "../http.js";
import type { Req, Router } from "../router.js";
import { ID, queryAll } from "../util.js";

const OWNER_ONLY = "Only site owners can see site usage.";
const noContent = { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
const COMMIT = /^[0-9a-f]{7,40}$/;

const viewSchema = z.object({
  kind: z.literal("view"),
  area: z.enum(AREAS),
  teamId: z.string().regex(ID).optional(),
  device: z.enum(DEVICES),
  source: z.enum(SOURCES).optional(),
  ms: z.number().min(0).max(120_000).optional(),
  commit: z.string().regex(COMMIT).optional()
}).strict();
const errorSchema = z.object({ kind: z.literal("error"), area: z.enum(AREAS) }).strict();
const shareSchema = z.object({ kind: z.literal("share"), teamId: z.string().regex(ID) }).strict();
const eventSchema = z.discriminatedUnion("kind", [viewSchema, errorSchema, shareSchema]);

function parse(raw: string | null): z.infer<typeof eventSchema> {
  let data: unknown;
  try { data = JSON.parse(raw || "{}"); } catch { throw badRequest("The request body isn't valid JSON."); }
  const p = eventSchema.safeParse(data);
  if (!p.success) throw badRequest("That usage event isn't valid.");
  return p.data;
}

/** A team page counts for its team only if the person can open that team (a member, its club's admin, or a site owner). */
async function teamFor(sub: string, teamId: string | undefined): Promise<{ clubId: string; teamId: string } | null> {
  if (!teamId) return null;
  const clubId = await clubOfTeam(teamId);
  const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: [keys.member(teamId, sub), keys.clubAdmin(clubId, sub), keys.platformAdmin(sub)] } } }));
  const items = res.Responses?.[TABLE] ?? [];
  const ok = items.some((i) => (String(i.SK).startsWith("MEMBER#") && i.status === "active") || String(i.SK).startsWith("ADMIN#"));
  return ok ? { clubId, teamId } : null;
}

async function record(e: z.infer<typeof eventSchema>, sub: string) {
  if (e.kind === "error") return countBrowserError(e.area);
  if (e.kind === "share") {
    const t = await teamFor(sub, e.teamId);
    if (t) await countAction(t.clubId, t.teamId, "shares");
    return;
  }
  const team = (TEAM_AREAS as readonly string[]).includes(e.area) ? await teamFor(sub, e.teamId) : null;
  await Promise.all([
    countView({ clubId: team?.clubId ?? "", teamId: team?.teamId ?? "", area: e.area, device: e.device, source: e.source, ms: e.ms }),
    ...(e.commit ? [noteRelease(e.commit)] : [])
  ]);
}

export function usagePublicRoutes(r: Router) {
  /** Pages anyone can open (help, sign-in, the front page): counts only, no team. */
  r.on("POST", "/public/usage", async ({ body }) => {
    const e = parse(body);
    if (e.kind === "share") throw badRequest("Sign in to share results.");
    if (!(PUBLIC_AREAS as readonly string[]).includes(e.area)) throw badRequest("That page needs a sign-in.");
    if (e.kind === "view" && e.teamId) throw badRequest("That page has no team.");
    await quietly(record(e, ""));
    return noContent;
  });
}

// ---------- reading ----------

const n = (r: Record<string, unknown>, f = "n") => Number(r[f] ?? 0);
const parts = (r: Row) => String(r.SK).split("#");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

function periodRange(period: Period, today: string): { from: string; to: string; prevFrom: string; prevTo: string; days: number } {
  if (period === "season") {
    const y = +today.slice(0, 4), m = +today.slice(5, 7);
    const from = `${m >= 7 ? y : y - 1}-07-01`;
    const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5) + 1;
    return { from, to: today, prevFrom: plusDays(from, -365), prevTo: plusDays(today, -365), days };
  }
  const days = period === "7d" ? 7 : 30;
  const from = plusDays(today, -(days - 1));
  return { from, to: today, prevFrom: plusDays(from, -days), prevTo: plusDays(from, -1), days };
}

type TeamRef = { teamId: string; name: string; clubId: string; clubName: string };

async function teamsOf(clubFilter: string): Promise<{ teams: TeamRef[]; clubs: { clubId: string; name: string }[] }> {
  const listed = (await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": "CLUBS" } })).map((c) => String(c.SK).slice(5));
  const ids = [...new Set([DEFAULT_CLUB(), ...listed])];
  const clubs = await getClubs(ids);
  const known = ids.filter((id) => clubs.has(id));
  const wanted = clubFilter && clubFilter !== "all" ? known.filter((id) => id === clubFilter) : known;
  const lists = await Promise.all(wanted.map((clubId) => queryAll({
    KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" },
    ProjectionExpression: "SK, archived, #n", ExpressionAttributeNames: { "#n": "name" }
  }).then((rows) => rows.filter((t) => !t.archived).map((t) => ({ teamId: String(t.SK).slice(5), name: String(t.name ?? t.SK).replace(/^TEAM#/, ""), clubId, clubName: clubs.get(clubId)!.name })))));
  return { teams: lists.flat(), clubs: known.map((id) => ({ clubId: id, name: clubs.get(id)!.name })).sort((a, b) => a.name.localeCompare(b.name)) };
}

type Status = "notStarted" | "quiet" | "steady" | "busy";

/** One team as it stands today: who's joined, who's opened it lately, answers, and features on. */
async function teamNow(t: TeamRef, clubFeatures: Partial<Record<string, boolean>>, today: string) {
  const [items, invites, seen] = await Promise.all([
    queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${t.teamId}` } }),
    queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :p AND begins_with(GSI1SK, :i)", ExpressionAttributeValues: { ":p": `TEAM#${t.teamId}`, ":i": "INVITE#" } }),
    seenRows(t.teamId)
  ]);
  const players = items.filter((i) => /^PLAYER#[^#]+$/.test(String(i.SK)));
  const members = items.filter((i) => String(i.SK).startsWith("MEMBER#") && i.status === "active");
  const families = new Map(items.filter((i) => String(i.SK).startsWith("FAMILY#")).map((i) => [String(i.pid ?? String(i.SK).slice(7)), i]));
  const settings = items.find((i) => i.SK === "META#SETTINGS") ?? null;
  const events = items.filter((i) => /^EVENT#[^#]+$/.test(String(i.SK)));
  const day = new Map(seen.map((s) => [String(s.SK), String(s.day ?? "")]));
  const since = (days: number) => plusDays(today, -(days - 1));
  const seenSince = (sub: string, days: number) => (day.get(sub) ?? "") >= since(days);

  const parentsOf = (pid: string) => members.filter((m) => m.pid === pid && (m.roles as string[] | undefined)?.includes("parent"));
  const waiting = invites.filter((i) => !isExpired(i));
  const pids = players.map((p) => String(p.pid ?? String(p.SK).slice(7)));
  const joined = pids.filter((pid) => parentsOf(pid).length > 0);
  const invited = pids.filter((pid) => joined.includes(pid) || waiting.some((i) => i.pid === pid));
  const answeredOnce = pids.filter((pid) => Object.keys((families.get(pid)?.rsvp as Record<string, unknown> | undefined) ?? {}).length > 0);
  const active30 = pids.filter((pid) => parentsOf(pid).some((m) => seenSince(String(m.sub), 30)));

  const memberSubs = members.map((m) => String(m.sub));
  const active7 = memberSubs.filter((s) => seenSince(s, 7));
  const active14 = memberSubs.filter((s) => seenSince(s, 14));
  const kinds = new Map(seen.map((s) => [String(s.SK), String(s.kind ?? "family")]));

  // Practices in the last 30 days, through today: how many players' families answered.
  const practices = buildItems(events as never, settings as never).filter((i) => i.kind === "practice" && !i.cancelled && i.date >= since(30) && i.date <= today);
  let pairs = 0, answered = 0;
  for (const it of practices) for (const pid of pids) {
    pairs++;
    if (((families.get(pid)?.rsvp as Record<string, unknown> | undefined) ?? {})[it.key]) answered++;
  }

  const lastSeen = [...day.values()].sort().at(-1) ?? "";
  const roster = pids.length;
  const status: Status = (!roster && !members.length) || (roster && joined.length / roster < 0.5) ? "notStarted"
    : members.length && active14.length < members.length * 0.5 ? "quiet"
    : members.length && active7.length >= members.length * 0.75 ? "busy" : "steady";
  const oldInvites = waiting.filter((i) => typeof i.at === "string" && i.at.slice(0, 10) <= plusDays(today, -7)).length;
  const why = status === "notStarted" && !roster && !members.length ? "No players or members yet."
    : status === "notStarted" ? `Under half the families have joined.${oldInvites ? ` ${oldInvites} invite${oldInvites === 1 ? "" : "s"} waiting over a week.` : ""}`
    : status === "quiet" ? "Families joined, but few have opened it in the last two weeks." : "";
  const features = effectiveFeatures((settings?.features ?? {}) as FeatureMap, clubFeatures as FeatureMap);

  return {
    ...t, roster, invited: invited.length, joined: joined.length, answeredOnce: answeredOnce.length, active30: active30.length,
    members: members.length, active7: active7.length, active7Family: active7.filter((s) => kinds.get(s) !== "staff").length,
    active7Staff: active7.filter((s) => kinds.get(s) === "staff").length,
    answeredPairs: answered, practicePairs: pairs, answeredPct: pct(answered, pairs), lastSeen, status, why, oldInvites,
    has: (f: Feature) => isOn(features, f)
  };
}

/** Features in use, and the pages that show each. Schedule and Game day are every team's. */
const FEATURE_USE: { label: string; areas: TeamArea[]; feature?: Feature }[] = [
  { label: "Schedule and availability", areas: ["schedule"] },
  { label: "Tournaments and game-day sheet", areas: ["tournaments", "gameday"] },
  { label: "Team fund and dues", areas: ["fund"], feature: "fund" },
  { label: "Practice attendance", areas: ["attendance"], feature: "attendance" },
  { label: "Match tracker and Stats", areas: ["matches", "stats"], feature: "matches" },
  { label: "Meals", areas: ["meals"], feature: "meals" },
  { label: "Ref jobs", areas: ["ref"], feature: "refjobs" },
  { label: "Travel and agendas", areas: ["travel", "agenda"], feature: "travel" },
  { label: "Team info and handbook", areas: ["info"] }
];

const query = (req: Req, k: string) => String(req.event?.queryStringParameters?.[k] ?? "");

async function usage(period: Period, club: string, today: string) {
  const range = periodRange(period, today);
  const { teams, clubs } = await teamsOf(club);
  const clubIds = new Set(teams.map((t) => t.clubId));
  const controls = await getControlsMany([...clubIds]);
  const firstWeek = plusDays(weekOf(today), -77);
  const [now, rows, prevRows, weeks] = await Promise.all([
    Promise.all(teams.map((t) => teamNow(t, controls.get(t.clubId)?.features ?? {}, today))),
    dailyRows("USAGE", range.from, range.to),
    dailyRows("USAGE", range.prevFrom, range.prevTo),
    weeklyRows(firstWeek, today)
  ]);
  const inClub = (c: string) => club === "all" || !club ? true : c === club;
  const teamIds = new Set(teams.map((t) => t.teamId));

  // Headline numbers, as things stand.
  const sum = (f: (t: (typeof now)[number]) => number) => now.reduce((a, t) => a + f(t), 0);
  const tiles = {
    active7: sum((t) => t.active7), active7Family: sum((t) => t.active7Family), active7Staff: sum((t) => t.active7Staff), members: sum((t) => t.members),
    teamsInUse: now.filter((t) => t.active7 > 0).length, teams: now.length,
    joined: sum((t) => t.joined), roster: sum((t) => t.roster),
    answeredPct: pct(sum((t) => t.answeredPairs), sum((t) => t.practicePairs)),
    needsLook: now.filter((t) => t.status === "notStarted" || t.status === "quiet").length
  };

  // People active each week (last 12 weeks).
  const weekly = Array.from({ length: 12 }, (_, i) => ({ week: plusDays(firstWeek, i * 7), family: 0, staff: 0 }));
  for (const w of weeks) {
    const [, week, c, team, kind] = parts(w);
    if (!inClub(c) || (club && club !== "all" && !teamIds.has(team))) continue;
    const slot = weekly.find((x) => x.week === week);
    if (slot) slot[kind === "staff" ? "staff" : "family"] += n(w);
  }

  // From the daily counts.
  const heat = Array.from({ length: 7 }, () => Array(8).fill(0) as number[]);
  const sources = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<string, number>;
  const devices = Object.fromEntries(DEVICES.map((d) => [d, 0])) as Record<string, number>;
  const views = new Map<string, number>(); // team#area
  const actions = (rs: Row[]) => {
    const out = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<Action, number>;
    for (const r of rs) {
      const p = parts(r);
      if (p[2] !== "ACT") continue;
      const [c, , action] = p.slice(3);
      if (club && club !== "all" && c !== club) continue;
      if (action in out) out[action as Action] += n(r);
    }
    return out;
  };
  for (const r of rows) {
    const p = parts(r);
    const kind = p[2];
    if (kind === "HR") {
      const dow = new Date(`${r.date}T12:00:00Z`).getUTCDay();
      heat[(dow + 6) % 7][Math.floor(Number(p[3]) / 3)] += n(r);
    } else if (kind === "V" && inClubFilter(club, p[3])) sources[p[4]] = (sources[p[4]] ?? 0) + n(r);
    else if (kind === "DEV" && inClubFilter(club, p[3])) devices[p[4]] = (devices[p[4]] ?? 0) + n(r);
    else if (kind === "P" && teamIds.has(p[4])) views.set(`${p[4]}#${p[5]}`, (views.get(`${p[4]}#${p[5]}`) ?? 0) + n(r));
  }
  const now_ = actions(rows), prev = actions(prevRows);

  const features = FEATURE_USE.map((f) => {
    const on = now.filter((t) => !f.feature || t.has(f.feature));
    const using = on.filter((t) => f.areas.some((a) => (views.get(`${t.teamId}#${a}`) ?? 0) > 0));
    const opens = now.reduce((s, t) => s + f.areas.reduce((m, a) => m + (views.get(`${t.teamId}#${a}`) ?? 0), 0), 0);
    return { label: f.label, teams: using.length, of: on.length, opens };
  });

  const order: Record<Status, number> = { notStarted: 0, quiet: 1, busy: 2, steady: 3 };
  const teamRows = now.map((t) => ({
    teamId: t.teamId, name: t.name, clubId: t.clubId, clubName: t.clubName, roster: t.roster, joined: t.joined, members: t.members,
    active7: t.active7, answeredPct: t.answeredPct, lastSeen: t.lastSeen, status: t.status, why: t.why,
    opens: TEAM_AREAS.reduce((s, a) => s + (views.get(`${t.teamId}#${a}`) ?? 0), 0)
  })).sort((a, b) => order[a.status] - order[b.status] || b.active7 - a.active7 || a.name.localeCompare(b.name));

  const worst = [...now].sort((a, b) => b.oldInvites - a.oldInvites)[0];
  return {
    period, ...range, today, club: club || "all", clubs,
    tiles, weekly, heat,
    funnel: { roster: tiles.roster, invited: sum((t) => t.invited), joined: tiles.joined, answeredOnce: sum((t) => t.answeredOnce), active30: sum((t) => t.active30) },
    waitingInvites: { n: sum((t) => t.oldInvites), worst: worst?.oldInvites ? { name: worst.name, n: worst.oldInvites } : null },
    sources: SOURCES.map((s) => ({ id: s, label: SOURCE_LABELS[s], n: sources[s] ?? 0 })),
    devices: DEVICES.map((d) => ({ id: d, n: devices[d] ?? 0 })),
    teams: teamRows, features,
    actions: ACTIONS.map((a) => ({ id: a, label: ACTION_LABELS[a], n: now_[a], prev: prev[a] }))
  };
}

const inClubFilter = (club: string, c: string) => !club || club === "all" || c === club;

type Health = Awaited<ReturnType<typeof health>>;

async function health(period: "24h" | "7d" | "30d", at = new Date()) {
  const today = stamp(at).date;
  const days = period === "24h" ? 2 : period === "7d" ? 7 : 30;
  const from = plusDays(today, -(days - 1));
  const [rows, usageRows, { teams }, rels] = await Promise.all([dailyRows("HEALTH", from, today), dailyRows("USAGE", from, today), teamsOf("all"), releases()]);

  // Requests per hour (per day for 30 days).
  const hourly = new Map<string, { n: number; err: number }>();
  const errors = new Map<string, { area: string; where: "server" | "browser"; n: number; lastAt: string }>();
  for (const r of rows) {
    const p = parts(r);
    if (p[2] === "H") {
      const k = period === "30d" ? r.date : `${r.date}T${p[3]}`;
      const h = hourly.get(k) ?? { n: 0, err: 0 };
      h.n += n(r); h.err += n(r, "err");
      hourly.set(k, h);
    } else if (p[2] === "E" || p[2] === "CE") {
      const browser = p[2] === "CE";
      const area = browser ? AREA_LABELS[p[3] as Area] ?? p[3] : p[3];
      const key = `${p[2]}#${area}`;
      const e = errors.get(key) ?? { area, where: browser ? "browser" as const : "server" as const, n: 0, lastAt: "" };
      e.n += n(r);
      const last = String(r.lastAt ?? `${r.date}T12:00:00Z`);
      if (last > e.lastAt) e.lastAt = last;
      errors.set(key, e);
    }
  }
  const points: { at: string; n: number; err: number }[] = [];
  if (period === "30d") for (let i = 0; i < 30; i++) { const d = plusDays(from, i); points.push({ at: d, ...(hourly.get(d) ?? { n: 0, err: 0 }) }); }
  else {
    const hours = period === "24h" ? 24 : 168;
    const nowKey = `${today}T${stamp(at).hour}`;
    const all: string[] = [];
    for (let i = 0; i < days; i++) for (let h = 0; h < 24; h++) all.push(`${plusDays(from, i)}T${String(h).padStart(2, "0")}`);
    const upTo = all.indexOf(nowKey);
    for (const k of all.slice(Math.max(0, upTo + 1 - hours), upTo + 1)) points.push({ at: k, ...(hourly.get(k) ?? { n: 0, err: 0 }) });
  }
  const total = points.reduce((a, p) => a + p.n, 0), failed = points.reduce((a, p) => a + p.err, 0);

  // How long pages took to open.
  const byArea = new Map<string, number[]>();
  const phones = Array(LOAD_BUCKETS.length).fill(0) as number[];
  for (const r of usageRows) {
    const p = parts(r);
    if (p[2] !== "L") continue;
    const [device, area, b] = p.slice(3);
    const arr = byArea.get(area) ?? Array(LOAD_BUCKETS.length).fill(0);
    arr[Number(b)] += n(r);
    byArea.set(area, arr);
    if (device === "phone") phones[Number(b)] += n(r);
  }
  const slowest = [...byArea.entries()].filter(([, c]) => c.reduce((a, b) => a + b, 0) >= 5)
    .map(([area, c]) => ({ area, label: AREA_LABELS[area as Area] ?? area, p95: p95(c)!, loads: c.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.p95 - a.p95).slice(0, 6);

  // Email, calendar feeds and open pages, from each team.
  const perTeam = await Promise.all(teams.map(async (t) => {
    const [mail, src, conns] = await Promise.all([
      queryAll({ KeyConditionExpression: "PK = :p AND SK BETWEEN :a AND :b", ExpressionAttributeValues: { ":p": `MAILSTATS#${t.teamId}`, ":a": `DAY#${from}`, ":b": `DAY#${today}~` } }),
      ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: [keys.feedSource(t.teamId)] } } })).then((r) => r.Responses?.[TABLE]?.[0]),
      ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", FilterExpression: "#ttl > :now", ExpressionAttributeNames: { "#ttl": "ttl" }, ExpressionAttributeValues: { ":p": `TEAMCONN#${t.teamId}`, ":now": Math.floor(at.getTime() / 1000) }, Select: "COUNT" })).then((r) => r.Count ?? 0)
    ]);
    const m = { sent: 0, delivered: 0, bounced: 0, complained: 0 };
    for (const r of mail) for (const k of Object.keys(m) as (keyof typeof m)[]) m[k] += n(r, k);
    const failing = !!src?.importedAt && (Number(src.failures ?? 0) >= 3 || !!src.attention);
    return { t, m, failing, conns };
  }));
  const mail = perTeam.reduce((a, x) => ({ sent: a.sent + x.m.sent, delivered: a.delivered + x.m.delivered, bounced: a.bounced + x.m.bounced, complained: a.complained + x.m.complained }), { sent: 0, delivered: 0, bounced: 0, complained: 0 });

  // Recent releases, and failures in the hour after each.
  const recent = rels.map((r) => ({ commit: String(r.commit ?? String(r.SK).slice(2)), at: String(r.at ?? "") })).filter((r) => r.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  const releaseRows = await Promise.all(recent.map(async (r) => {
    const s = stamp(new Date(r.at));
    const later = stamp(new Date(Date.parse(r.at) + 3600_000));
    const hrs = await dailyRows("HEALTH", s.date, later.date);
    const want = new Set([`${s.date}T${s.hour}`, `${later.date}T${later.hour}`]);
    const errs = hrs.filter((h) => parts(h)[2] === "H" && want.has(`${h.date}T${parts(h)[3]}`)).reduce((a, h) => a + n(h, "err"), 0);
    return { ...r, errorsAfter: errs };
  }));

  return {
    period, from, to: today,
    requests: { total, failed, failedPct: total ? Math.round((failed / total) * 1000) / 10 : null },
    pages: { phoneP95: p95(phones), loads: phones.reduce((a, b) => a + b, 0) },
    mail: { ...mail, deliveredPct: mail.sent ? Math.round((mail.delivered / mail.sent) * 1000) / 10 : null },
    feeds: { failing: perTeam.filter((x) => x.failing).map((x) => ({ teamId: x.t.teamId, name: x.t.name })) },
    liveNow: perTeam.reduce((a, x) => a + x.conns, 0),
    points, errors: [...errors.values()].sort((a, b) => b.n - a.n).slice(0, 10), slowest, releases: releaseRows
  };
}

export function usageRoutes(r: Router) {
  /** The site reports a page it opened, an error in the browser, or results shared. */
  r.on("POST", "/usage/events", async ({ body, caller }) => {
    const e = parse(body);
    await quietly(record(e, caller.sub));
    return noContent;
  });

  r.on("GET", "/admin/usage", async (req) => {
    await requirePlatformAdmin(req.caller, OWNER_ONLY);
    const period = (["7d", "30d", "season"] as Period[]).find((p) => p === query(req, "period")) ?? "30d";
    const club = query(req, "club") || "all";
    if (club !== "all" && !ID.test(club)) throw badRequest("Invalid club.");
    return json(200, await usage(period, club, stamp().date));
  });

  r.on("GET", "/admin/health", async (req) => {
    await requirePlatformAdmin(req.caller, OWNER_ONLY);
    const period = (["24h", "7d", "30d"] as const).find((p) => p === query(req, "period")) ?? "7d";
    return json(200, await health(period) satisfies Health);
  });
}
