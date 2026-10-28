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
import { MATCH_ID, MAX_SLOTS, matchProblem, slotsFor, suggestedResult, tournamentDays, type Match, type MatchDoc } from "../../shared/matches.js";
import { loadAccess, type TeamAccess } from "../context.js";
import { badRequest, forbidden, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, getItem, now, optStr } from "../util.js";

const score = z.number().int().min(0).max(99);
const matchSchema = z.object({
  time: optStr(20), court: optStr(40), opponent: optStr(80),
  format: z.union([z.literal(2), z.literal(3), z.literal(5)]).default(3),
  sets: z.array(z.object({ us: score, them: score })).max(5).default([]),
  result: z.enum(["W", "L", ""]).default("")
}).strict();
const slotsSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slots: z.number().int().min(1).max(MAX_SLOTS) }).strict();
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

export function matchRoutes(r: Router) {
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

