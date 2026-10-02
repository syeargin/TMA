import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { loadAccess } from "../context.js";
import { badRequest, conflict, forbidden, json, mapDbError, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { cents, checkId, date, deleteItem, deleteMany, getItem, now, optStr, putItem, queryAll, str } from "../util.js";

const parent = z.object({ name: str(120), cell: optStr(40), email: z.string().trim().max(200).optional() });
const playerSchema = z.object({
  first: str(60).min(1), last: optStr(60), jersey: optStr(10), shirt: optStr(20), town: optStr(120),
  allergies: optStr(200), refTeam: z.enum(["A", "B"]).optional(), order: z.number().int().min(0).max(999).optional(),
  parents: z.array(parent).max(4).default([])
});

const eventSchema = z.object({
  kind: z.enum(["tournament", "event", "deadline"]),
  title: str(160).min(1),
  date,
  endDate: date.optional(),
  time: optStr(40), location: optStr(200), city: optStr(120), division: optStr(60), website: optStr(500),
  travel: z.boolean().default(false), dutyPid: optStr(64),
  parking: optStr(500), waves: optStr(200), arrival: optStr(100), start: optStr(100), meet: optStr(300),
  uniforms: optStr(500), admissions: optStr(500), teamCode: optStr(60), scheduleLink: optStr(500), ticketHelp: optStr(500),
  foodPlan: optStr(2000), reservations: optStr(1000), notes: optStr(2000),
  hotel: optStr(200), hotelLink: optStr(500), hotelCode: optStr(100), hotelBy: optStr(60),
  checklist: z.array(str(200)).max(60).optional(),
  // Repeating events (not tournaments): every N weeks on these weekdays (0 = Sunday) until a date.
  repeat: z.object({
    every: z.number().int().min(1).max(4).default(1),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
    until: date,
    skipTournaments: z.boolean().default(true)
  }).optional(),
  cancelled: z.array(date).max(400).optional(), // occurrences shown as cancelled
  skip: z.array(date).max(400).optional()       // occurrences left out entirely
}).refine((e) => !e.repeat || e.kind !== "tournament", "Tournaments can't repeat.")
  .refine((e) => !e.repeat || e.repeat.until >= e.date, "The series ends before it starts.");

/** Turn separate events that follow a weekly pattern into one repeating event. */
const combineSchema = z.object({
  eids: z.array(z.string()).min(2).max(150),
  repeat: z.object({
    every: z.number().int().min(1).max(4),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    until: date,
    skipTournaments: z.boolean().default(true)
  }),
  skip: z.array(date).max(400).default([])
});

const refGroupsSchema = z.object({ groups: z.record(z.enum(["A", "B"])) });
const refjobsSchema = z.object({
  assign: z.record(z.object({ s1: optStr(20), s2: optStr(20), s3: optStr(20) }))
});
const agendaSchema = z.object({
  note: optStr(1000),
  days: z.array(z.object({ label: str(100), items: z.array(z.object({ what: str(300), where: optStr(500), who: optStr(200) })).max(60) })).max(10)
});
const mealSchema = z.object({
  day: date.optional(), meal: str(60).min(1), time: optStr(40), plan: optStr(1000), costCents: cents.default(0),
  claimedBy: z.string().max(64).nullable().optional()
});
const claimSchema = z.object({ pid: str(64).min(1) });
const announcementSchema = z.object({ text: str(4000).min(1), pinned: z.boolean().default(false) });
const taskSchema = z.object({ title: str(200).min(1), desc: optStr(1000), owner: optStr(120), status: z.enum(["To do", "In progress", "Done", "N/A"]).default("To do"), order: z.number().int().min(0).max(9999).optional() });

export function contentRoutes(r: Router) {
  // ---------- roster ----------
  r.on("PUT", "/teams/{teamId}/players/{pid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("roster");
    const pid = checkId(params.pid, "player");
    const { parents, ...player } = parseBody(playerSchema, body);
    const at = now();
    await putItem({ ...keys.player(a.teamId, pid), type: "Player", ...player, updatedAt: at, updatedBy: caller.sub });
    await putItem({ ...keys.contacts(a.teamId, pid), type: "Contacts", parents, updatedAt: at });
    return json(200, { pid });
  });

  r.on("DELETE", "/teams/{teamId}/players/{pid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("roster");
    const pid = checkId(params.pid, "player");
    await deleteMany([keys.player(a.teamId, pid), keys.contacts(a.teamId, pid), keys.family(a.teamId, pid)]);
    return json(204, undefined);
  });

  // ---------- events ----------
  r.on("PUT", "/teams/{teamId}/events/{eid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("schedule");
    const eid = checkId(params.eid, "event");
    const ev = parseBody(eventSchema, body);
    await putItem({
      ...keys.event(a.teamId, eid), type: "Event", ...ev,
      GSI2PK: `TEAM#${a.teamId}#CAL`, GSI2SK: `${ev.date}#${eid}`,
      updatedAt: now(), updatedBy: caller.sub
    });
    return json(200, { eid });
  });

  r.on("POST", "/teams/{teamId}/events/combine", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("schedule");
    const b = parseBody(combineSchema, body);
    const eids = [...new Set(b.eids.map((e) => checkId(e, "event")))];
    const events = await Promise.all(eids.map((eid) => getItem(keys.event(a.teamId, eid))));
    if (events.some((e) => !e)) throw notFound("One of those events no longer exists. Refresh and try again.");
    const evs = (events as Record<string, unknown>[]).map((e, i): Record<string, unknown> & { eid: string } => ({ ...e, eid: eids[i] }))
      .sort((x, y) => String(x.date).localeCompare(String(y.date)));
    if (evs.some((e) => e.kind === "tournament" || e.repeat)) throw badRequest("Only separate one-time events can be combined.");
    const first = evs[0];
    const seriesId = first.eid;
    const { PK: _pk, SK: _sk, eid: _e, GSI2PK: _g1, GSI2SK: _g2, updatedAt: _u, updatedBy: _ub, ...base } = first;
    const days = [...new Set(b.repeat.days)].sort();
    await putItem({
      ...keys.event(a.teamId, seriesId), ...base, type: "Event",
      repeat: { ...b.repeat, days }, skip: b.skip, cancelled: [],
      GSI2PK: `TEAM#${a.teamId}#CAL`, GSI2SK: `${first.date}#${seriesId}`,
      updatedAt: now(), updatedBy: caller.sub
    });
    // Move families' availability answers onto the series dates, then remove the old one-time events.
    const moves = evs.map((e) => [e.eid, `${seriesId}-${e.date}`] as const);
    const families = await queryAll({
      KeyConditionExpression: "PK = :p AND begins_with(SK, :f)",
      ExpressionAttributeValues: { ":p": `TEAM#${a.teamId}`, ":f": "FAMILY#" }
    });
    let moved = 0;
    for (const f of families) {
      const rsvp = (f.rsvp ?? {}) as Record<string, unknown>;
      if (!moves.some(([from]) => rsvp[from])) continue;
      const next = { ...rsvp };
      for (const [from, to] of moves) if (next[from]) { next[to] = next[from]; delete next[from]; moved++; }
      await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { PK: String(f.PK), SK: String(f.SK) },
        UpdateExpression: "SET rsvp = :r", ExpressionAttributeValues: { ":r": next } }));
    }
    await deleteMany(evs.slice(1).map((e) => keys.event(a.teamId, e.eid)));
    return json(200, { eid: seriesId, combined: evs.length, answersMoved: moved });
  });

  r.on("DELETE", "/teams/{teamId}/events/{eid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("schedule");
    const eid = checkId(params.eid, "event");
    const children = await queryAll({
      KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
      ExpressionAttributeValues: { ":p": `TEAM#${a.teamId}`, ":s": `EVENT#${eid}#` },
      ProjectionExpression: "PK, SK"
    });
    await deleteMany([keys.event(a.teamId, eid), ...(children as { PK: string; SK: string }[])]);
    return json(204, undefined);
  });

  /** Split the roster into ref job groups A and B. Only touches each player's refTeam. */
  r.on("PUT", "/teams/{teamId}/refgroups", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("refjobs");
    const { groups } = parseBody(refGroupsSchema, body);
    const entries = Object.entries(groups);
    if (entries.length > 40) throw badRequest("Too many players.");
    for (const [pid, group] of entries) {
      checkId(pid, "player");
      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE, Key: keys.player(a.teamId, pid),
          UpdateExpression: "SET refTeam = :g, updatedAt = :at, updatedBy = :by",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":g": group, ":at": now(), ":by": caller.sub }
        }));
      } catch (e) { mapDbError(e, `Player ${pid} isn't on this team.`); }
    }
    return json(200, { groups });
  });

  r.on("PUT", "/teams/{teamId}/events/{eid}/refjobs", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("refjobs");
    const eid = checkId(params.eid, "event");
    const b = parseBody(refjobsSchema, body);
    await putItem({ ...keys.refjobs(a.teamId, eid), type: "RefJobs", ...b, updatedAt: now(), updatedBy: caller.sub });
    return json(200, { eid });
  });

  r.on("PUT", "/teams/{teamId}/events/{eid}/agenda", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    if (!a.can("schedule") && !a.can("meals")) throw forbidden();
    const eid = checkId(params.eid, "event");
    const b = parseBody(agendaSchema, body);
    await putItem({ ...keys.agenda(a.teamId, eid), type: "Agenda", ...b, updatedAt: now(), updatedBy: caller.sub });
    return json(200, { eid });
  });

  // ---------- meals ----------
  r.on("PUT", "/teams/{teamId}/events/{eid}/meals/{mid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("meals");
    const eid = checkId(params.eid, "event"), mid = checkId(params.mid, "meal");
    const m = parseBody(mealSchema, body);
    const existing = await getItem(keys.meal(a.teamId, eid, mid));
    const claimedBy = m.claimedBy === undefined ? (existing?.claimedBy ?? null) : m.claimedBy || null;
    await putItem({ ...keys.meal(a.teamId, eid, mid), type: "Meal", ...m, claimedBy, updatedAt: now(), updatedBy: caller.sub });
    return json(200, { mid });
  });

  r.on("DELETE", "/teams/{teamId}/events/{eid}/meals/{mid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("meals");
    await deleteItem(keys.meal(a.teamId, checkId(params.eid, "event"), checkId(params.mid, "meal")));
    return json(204, undefined);
  });

  r.on("POST", "/teams/{teamId}/events/{eid}/meals/{mid}/claim", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    const { pid } = parseBody(claimSchema, body);
    if (!a.isParentOf(pid) && !a.can("meals")) throw forbidden("You can only sign up your own family.");
    const key = keys.meal(a.teamId, checkId(params.eid, "event"), checkId(params.mid, "meal"));
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: key,
        UpdateExpression: "SET claimedBy = :pid, claimedAt = :at, claimedBySub = :sub",
        ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(claimedBy) OR claimedBy = :null)",
        ExpressionAttributeValues: { ":pid": pid, ":at": now(), ":sub": caller.sub, ":null": null }
      }));
    } catch (e) { mapDbError(e, "Another family already took this meal."); }
    return json(200, { claimedBy: pid });
  });

  r.on("DELETE", "/teams/{teamId}/events/{eid}/meals/{mid}/claim", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    const key = keys.meal(a.teamId, checkId(params.eid, "event"), checkId(params.mid, "meal"));
    const meal = await getItem(key);
    if (!meal) throw notFound("That meal doesn't exist.");
    if (!meal.claimedBy) throw conflict("Nobody has claimed this meal.");
    if (!a.isParentOf(String(meal.claimedBy)) && !a.can("meals")) throw forbidden("Only that family or a food coordinator can release this meal.");
    await ddb.send(new UpdateCommand({ TableName: TABLE, Key: key, UpdateExpression: "SET claimedBy = :null REMOVE claimedAt, claimedBySub", ExpressionAttributeValues: { ":null": null } }));
    return json(200, { claimedBy: null });
  });

  // ---------- announcements & tasks ----------
  r.on("PUT", "/teams/{teamId}/announcements/{aid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("announce");
    const aid = checkId(params.aid, "announcement");
    const b = parseBody(announcementSchema, body);
    const existing = await getItem(keys.announcement(a.teamId, aid));
    const at = String(existing?.at ?? now());
    await putItem({ ...keys.announcement(a.teamId, aid), type: "Announcement", ...b, by: existing?.by ?? caller.sub, at,
      GSI2PK: `TEAM#${a.teamId}#ANN`, GSI2SK: `${at}#${aid}`, updatedAt: now() });
    return json(200, { aid });
  });

  r.on("DELETE", "/teams/{teamId}/announcements/{aid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("announce");
    await deleteItem(keys.announcement(a.teamId, checkId(params.aid, "announcement")));
    return json(204, undefined);
  });

  r.on("PUT", "/teams/{teamId}/tasks/{kid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("tasks");
    const kid = checkId(params.kid, "task");
    await putItem({ ...keys.task(a.teamId, kid), type: "Task", ...parseBody(taskSchema, body), updatedAt: now(), updatedBy: caller.sub });
    return json(200, { kid });
  });

  r.on("DELETE", "/teams/{teamId}/tasks/{kid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("tasks");
    await deleteItem(keys.task(a.teamId, checkId(params.kid, "task")));
    return json(204, undefined);
  });
}
