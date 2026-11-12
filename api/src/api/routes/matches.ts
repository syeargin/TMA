/**
 * Tournament match tracker (shared/matches.ts). Coaches, coordinators and team admins (the `scores`
 * permission) enter scores, change how many match rows a day has and choose a scorekeeper: one
 * parent per tournament who can also enter and fix scores, for that tournament only.
 *
 * Each match is saved on its own (`matches.<date>-<n>`), so two people entering different matches
 * at once don't overwrite each other.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { MATCH_ID, MAX_SLOTS, REF_JOBS, matchProblem, nextGroup, onDuty, rotateJobs, slotsFor, suggestedResult, tournamentDays, workList, type Match, type MatchDoc, type RefAssign, type WorkGroup, type WorkMatch } from "../../shared/matches.js";
import { loadAccess, type TeamAccess } from "../context.js";
import { badRequest, forbidden, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, getItem, newId, now, optStr, queryAll, str } from "../util.js";

const score = z.number().int().min(0).max(99);
const matchSchema = z.object({
  time: optStr(20), court: optStr(40), opponent: optStr(80),
  format: z.union([z.literal(2), z.literal(3), z.literal(5)]).default(3),
  sets: z.array(z.object({ us: score, them: score })).max(5).default([]),
  result: z.enum(["W", "L", ""]).default("")
}).strict();
const slotsSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slots: z.number().int().min(1).max(MAX_SLOTS) }).strict();
const workSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: optStr(20), court: optStr(40), matchNo: optStr(20),
  teams: z.tuple([str(80), str(80)]).refine((t) => t[0] || t[1], "Enter the teams playing (or at least one)."),
  /** Leave out (or null) to pick the group automatically. */
  group: z.enum(["A", "B", "all"]).nullable().optional()
}).strict();
const jobsSchema = z.object({ jobs: z.record(z.string().max(64), z.object({ s1: z.enum(["", ...REF_JOBS] as [string, ...string[]]).optional(), s2: z.enum(["", ...REF_JOBS] as [string, ...string[]]).optional(), s3: z.enum(["", ...REF_JOBS] as [string, ...string[]]).optional() })) }).strict();
const keeperSchema = z.object({ sub: z.string().max(64).nullable() }).strict();

async function tournament(a: TeamAccess, eid: string) {
  const e = await getItem(keys.event(a.teamId, eid));
  if (!e || e.kind !== "tournament") throw notFound("That tournament isn't on the schedule.");
  return { e, days: tournamentDays(String(e.date), e.endDate ? String(e.endDate) : undefined) };
}

/** Staff, or this tournament's scorekeeper. */
function canScore(a: TeamAccess, doc: MatchDoc | undefined) {
  return a.can("scores") || (!!doc?.scorekeeper && doc.scorekeeper === a.caller.sub && a.member?.status === "active");
}

/** Creates the record with empty maps, so the nested SETs below have somewhere to go. */
async function ensure(teamId: string, eid: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.matches(teamId, eid),
    UpdateExpression: "SET #t = if_not_exists(#t, :type), matches = if_not_exists(matches, :e), slots = if_not_exists(slots, :e)",
    ExpressionAttributeNames: { "#t": "type" }, ExpressionAttributeValues: { ":type": "Matches", ":e": {} }
  }));
}

/** Who can add the matches the team works and set their ref jobs: anyone who enters scores (staff) or assigns ref jobs. */
function canWork(a: TeamAccess) { return a.can("scores") || a.can("refjobs"); }

async function roster(teamId: string) {
  const rows = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": "PLAYER#" } });
  return rows.filter((r) => !String(r.SK).endsWith("#CONTACTS")).map((r) => ({ pid: String(r.SK).slice(7), refTeam: r.refTeam as string | undefined, order: Number(r.order ?? 999), first: String(r.first ?? "") }))
    .sort((a, b) => a.order - b.order || a.first.localeCompare(b.first));
}

/** Jobs for the players on duty, rotated on from the group's earlier work matches. */
function jobsFor(players: { pid: string; refTeam?: string }[], group: WorkGroup, doc: MatchDoc | undefined, id: string): RefAssign {
  const earlier = workList(doc).filter((w) => w.group === group && w.id !== id).length;
  return rotateJobs(onDuty(players, group).map((p) => p.pid), earlier);
}

export function matchRoutes(r: Router) {
  /**
   * A match the team works: create (new id) or change. Without a group, it goes to the group with fewer
   * work matches so far. The on-duty group's jobs are filled by rotation when it's created or its group changes.
   */
  r.on("PUT", "/teams/{teamId}/events/{eid}/work/{wid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("matches");
    if (!canWork(a)) throw forbidden("Only coaches, coordinators and team admins can add the matches the team works.");
    const eid = checkId(params.eid, "event");
    const wid = params.wid === "new" ? newId("w") : checkId(params.wid, "match");
    const b = parseBody(workSchema, body);
    const { days } = await tournament(a, eid);
    if (!days.includes(b.date)) throw badRequest("That day isn't part of the tournament.");
    const doc = (await getItem(keys.matches(a.teamId, eid))) as MatchDoc | undefined;
    const old = doc?.work?.[wid];
    if (params.wid !== "new" && !old) throw notFound("That match isn't on the list any more.");
    if (!old && Object.keys(doc?.work ?? {}).length >= 40) throw badRequest("That's a lot of work matches. Remove one first.");
    const players = await roster(a.teamId);
    const hasB = players.some((p) => p.refTeam === "B");
    // Left out: keep the group (new: pick one). null: pick one again ("auto"). A group: that one.
    const group: WorkGroup = b.group === undefined ? (old?.group ?? nextGroup(doc, hasB, wid)) : b.group ?? nextGroup(doc, hasB, wid);
    const auto = b.group === undefined ? (old?.auto ?? true) : b.group === null;
    const w: WorkMatch = {
      id: wid, date: b.date, teams: b.teams, group, auto, ...(old?.shift ? { shift: old.shift } : {}),
      ...(b.time ? { time: b.time } : {}), ...(b.court ? { court: b.court } : {}), ...(b.matchNo ? { matchNo: b.matchNo } : {}),
      jobs: old && old.group === group && old.jobs ? old.jobs : jobsFor(players, group, doc, wid),
      updatedAt: now(), updatedBy: caller.sub
    };
    await ensure(a.teamId, eid);
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.matches(a.teamId, eid),
      UpdateExpression: "SET #w = if_not_exists(#w, :e), updatedAt = :at", ExpressionAttributeNames: { "#w": "work" }, ExpressionAttributeValues: { ":e": {}, ":at": now() }
    }));
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.matches(a.teamId, eid),
      UpdateExpression: "SET #w.#id = :m", ExpressionAttributeNames: { "#w": "work", "#id": wid }, ExpressionAttributeValues: { ":m": w }
    }));
    return json(200, { work: w });
  });

  r.on("DELETE", "/teams/{teamId}/events/{eid}/work/{wid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("matches");
    if (!canWork(a)) throw forbidden();
    const eid = checkId(params.eid, "event");
    const wid = checkId(params.wid, "match");
    const doc = (await getItem(keys.matches(a.teamId, eid))) as MatchDoc | undefined;
    if (doc?.work?.[wid]) {
      await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.matches(a.teamId, eid), UpdateExpression: "REMOVE #w.#id SET updatedAt = :at", ExpressionAttributeNames: { "#w": "work", "#id": wid }, ExpressionAttributeValues: { ":at": now() } }));
    }
    return json(204, undefined);
  });

  /** A work match's jobs: set them, or (rotate: true) fill them again by rotation. */
  r.on("PUT", "/teams/{teamId}/events/{eid}/work/{wid}/jobs", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("matches");
    if (!canWork(a)) throw forbidden("Only coaches, coordinators and team admins can change ref jobs.");
    const eid = checkId(params.eid, "event");
    const wid = checkId(params.wid, "match");
    const doc = (await getItem(keys.matches(a.teamId, eid))) as MatchDoc | undefined;
    const w = doc?.work?.[wid];
    if (!w) throw notFound("That match isn't on the list any more.");
    let jobs: RefAssign;
    const b = parseBody(z.union([z.object({ rotate: z.literal(true) }).strict(), jobsSchema]), body);
    if ("rotate" in b) {
      // Shift one place from what it is now, so "Rotate again" always changes something.
      const players = onDuty(await roster(a.teamId), w.group).map((p) => p.pid);
      w.shift = (w.shift ?? 0) + 1;
      jobs = rotateJobs(players, workList(doc).filter((x) => x.group === w.group && x.id !== wid).length + w.shift);
    } else {
      jobs = Object.fromEntries(Object.entries(b.jobs).map(([pid, j]) => [pid, Object.fromEntries(Object.entries(j).filter(([, v]) => v))]));
    }
    const next = { ...w, jobs, updatedAt: now(), updatedBy: caller.sub };
    await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.matches(a.teamId, eid), UpdateExpression: "SET #w.#id = :m, updatedAt = :at", ExpressionAttributeNames: { "#w": "work", "#id": wid }, ExpressionAttributeValues: { ":m": next, ":at": now() } }));
    return json(200, { work: next });
  });

  /** Saves one match: `mid` is `<date>-<n>`, the day and its row. */
  r.on("PUT", "/teams/{teamId}/events/{eid}/matches/{mid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("matches");
    const eid = checkId(params.eid, "event");
    const id = MATCH_ID.exec(params.mid ?? "");
    if (!id) throw badRequest("Invalid match.");
    const [, date, nText] = id;
    const n = Number(nText);
    const { days } = await tournament(a, eid);
    if (!days.includes(date)) throw badRequest("That day isn't part of the tournament.");
    if (n < 1 || n > MAX_SLOTS) throw badRequest(`A day has at most ${MAX_SLOTS} matches.`);
    const doc = (await getItem(keys.matches(a.teamId, eid))) as MatchDoc | undefined;
    if (!canScore(a, doc)) throw forbidden("Only coaches, coordinators, team admins and this tournament's scorekeeper can enter scores.");
    const b = parseBody(matchSchema, body);
    // Sets after the last one with a score are left off, so "25–20, 25–18, (blank)" is 2 sets.
    while (b.sets.length && !b.sets.at(-1)!.us && !b.sets.at(-1)!.them) b.sets.pop();
    const result = b.result || suggestedResult(b);
    const problem = matchProblem({ ...b, result });
    if (!problem && !result && b.format === 2 && b.sets.length === 2) throw badRequest("The sets are 1–1: pick Win or Loss.");
    if (problem) throw badRequest(problem);
    const m: Match = { date, n, format: b.format, sets: b.sets, result, ...(b.time ? { time: b.time } : {}), ...(b.court ? { court: b.court } : {}), ...(b.opponent ? { opponent: b.opponent } : {}), updatedAt: now(), updatedBy: caller.sub };
    await ensure(a.teamId, eid);
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.matches(a.teamId, eid),
      UpdateExpression: "SET matches.#m = :m, updatedAt = :at",
      ExpressionAttributeNames: { "#m": params.mid! }, ExpressionAttributeValues: { ":m": m, ":at": now() }
    }));
    return json(200, { match: m });
  });

  /** Clears one match back to an empty row. */
  r.on("DELETE", "/teams/{teamId}/events/{eid}/matches/{mid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("matches");
    const eid = checkId(params.eid, "event");
    if (!MATCH_ID.test(params.mid ?? "")) throw badRequest("Invalid match.");
    const doc = (await getItem(keys.matches(a.teamId, eid))) as MatchDoc | undefined;
    if (!canScore(a, doc)) throw forbidden();
    if (doc?.matches?.[params.mid!]) {
      await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.matches(a.teamId, eid), UpdateExpression: "REMOVE matches.#m SET updatedAt = :at", ExpressionAttributeNames: { "#m": params.mid! }, ExpressionAttributeValues: { ":at": now() } }));
    }
    return json(204, undefined);
  });

  /**
   * How many match rows a day shows (3 to start). Anyone who can enter scores can add a row; only
   * staff take one away, and never below the matches already entered that day.
   */
  r.on("PUT", "/teams/{teamId}/events/{eid}/matchslots", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("matches");
    const eid = checkId(params.eid, "event");
    const b = parseBody(slotsSchema, body);
    const { days } = await tournament(a, eid);
    if (!days.includes(b.date)) throw badRequest("That day isn't part of the tournament.");
    const doc = (await getItem(keys.matches(a.teamId, eid))) as MatchDoc | undefined;
    if (!canScore(a, doc)) throw forbidden();
    const shown = slotsFor(doc, b.date);
    if (b.slots < shown && !a.can("scores")) throw forbidden("Only coaches, coordinators and team admins can remove a match row.");
    const entered = Object.values(doc?.matches ?? {}).filter((m) => m.date === b.date).reduce((n, m) => Math.max(n, m.n), 0);
    if (b.slots < entered) throw badRequest("Clear the last match's score before removing its row.");
    await ensure(a.teamId, eid);
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.matches(a.teamId, eid),
      UpdateExpression: "SET slots.#d = :n, updatedAt = :at",
      ExpressionAttributeNames: { "#d": b.date }, ExpressionAttributeValues: { ":n": b.slots, ":at": now() }
    }));
    return json(200, { date: b.date, slots: b.slots });
  });

  /** Chooses the tournament's scorekeeper (a parent on the team), or none. */
  r.on("PUT", "/teams/{teamId}/events/{eid}/scorekeeper", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("scores");
    a.requireFeature("matches");
    const eid = checkId(params.eid, "event");
    await tournament(a, eid);
    const { sub } = parseBody(keeperSchema, body);
    if (sub) {
      const m = await getItem(keys.member(a.teamId, checkId(sub, "member")));
      if (!m || m.status !== "active" || !((m.roles as string[]) ?? []).includes("parent")) throw badRequest("The scorekeeper has to be a parent on the team.");
    }
    await ensure(a.teamId, eid);
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.matches(a.teamId, eid),
      UpdateExpression: sub ? "SET scorekeeper = :s, updatedAt = :at" : "REMOVE scorekeeper SET updatedAt = :at",
      ExpressionAttributeValues: { ...(sub ? { ":s": sub } : {}), ":at": now() }
    }));
    return json(200, { scorekeeper: sub });
  });
}

