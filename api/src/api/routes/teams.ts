import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { clubOfTeam, DEFAULT_CLUB, forgetTeamClubs, getClub, getClubs } from "../../lib/clubs.js";
import { keys } from "../../lib/keys.js";
import { convertPractices } from "../../lib/practices.js";
import { isPlatformAdmin, loadAccess, loadClubAccess } from "../context.js";
import { badRequest, conflict, forbidden, json, mapDbError, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, clean, deleteMany, getItem, now, optStr, putItem, queryAll, str } from "../util.js";

const coach = z.object({ name: str(100), phone: optStr(40) });
const practice = z.object({
  id: str(40), label: str(100), dow: z.number().int().min(0).max(6),
  start: optStr(20), end: optStr(20), from: optStr(10), until: optStr(10), location: optStr(200), note: optStr(300)
});

const settingsSchema = z.object({
  teamName: str(100).min(1),
  season: optStr(20),
  age: optStr(20),
  coaches: z.array(coach).max(6).default([]),
  teamCode: optStr(40),
  dues: z.object({ amountCents: z.number().int().min(0).max(10_000_00), due: optStr(10), label: optStr(100) }).partial().default({}),
  budget: z.record(z.number()).optional(), // left out = keep what's saved
  // Left out = keep what's saved (coaches manage these through the /practices routes).
  practices: z.array(practice).max(20).optional(),
  cancelled: z.array(str(80)).max(500).optional(),
  checklist: z.array(str(200)).max(60).default([]),
  uniformItems: z.array(str(200)).max(60).default([]),
  /** Practice uniform colors offered when adding a practice. Left out = keep what's saved. */
  practiceColors: z.array(str(40).min(1)).max(20).optional()
});

const practicesSchema = z.object({ practices: z.array(practice).max(20) });
const MAX_CANCELLED = 500;

const handbookSchema = z.object({ sections: z.array(z.object({ t: str(200), b: str(10_000) })).max(60) });

const createTeamSchema = z.object({
  /** Left out: the default club. */
  clubId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/).optional(),
  teamId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, numbers and dashes"),
  name: str(100).min(1),
  season: optStr(20),
  age: optStr(20),
  coaches: z.array(coach).max(6).default([]),
  copyFrom: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/).optional(),
  copy: z.array(z.enum(["handbook", "lists", "practices", "money"])).default(["handbook", "lists"])
});

const DEFAULT_CHECKLIST = ["Court shoes", "Extra pair of socks", "Knee and elbow pads", "2 pairs of spandex", "Both jerseys", "Warmups", "Hair ties, ribbons, brush", "Volleyball backpack", "Water bottle", "Snacks", "Lunch"];

/** Groups a team partition into the shape the site uses, hiding what the caller's roles can't see. */
export function bundle(items: Record<string, unknown>[], access: Awaited<ReturnType<typeof loadAccess>>) {
  const out = {
    teamId: access.teamId,
    you: { sub: access.caller.sub, roles: [...access.roles], pid: access.member?.pid ?? "", person: access.member?.person ?? "", clubAdmin: access.clubAdmin },
    clubId: access.clubId,
    settings: null as unknown, handbook: null as unknown,
    players: [] as Record<string, unknown>[], events: [] as unknown[], meals: [] as unknown[],
    refjobs: {} as Record<string, unknown>, agenda: {} as Record<string, unknown>,
    family: {} as Record<string, unknown>, ledger: [] as unknown[], payments: [] as unknown[],
    announcements: [] as unknown[], tasks: [] as unknown[], members: [] as unknown[]
  };
  const contacts: Record<string, unknown> = {};
  const showContacts = access.can("contacts");
  const showFund = access.can("fundView");
  const finance = access.can("finance");
  const accounts = access.can("accounts");

  for (const it of items) {
    const sk = String(it.SK);
    const c = clean(it)!;
    if (sk === "META#SETTINGS") out.settings = c;
    else if (sk === "META#HANDBOOK") out.handbook = c;
    else if (sk.startsWith("META#")) continue;
    else if (sk.startsWith("PLAYER#") && sk.endsWith("#CONTACTS")) { if (showContacts) contacts[sk.slice(7, -9)] = c; }
    else if (sk.startsWith("PLAYER#")) out.players.push({ pid: sk.slice(7), ...c });
    else if (sk.startsWith("EVENT#")) {
      const parts = sk.split("#"); // EVENT, eid, [REFJOBS|AGENDA|MEAL, mid]
      const eid = parts[1];
      if (parts.length === 2) out.events.push({ eid, ...c });
      else if (parts[2] === "REFJOBS") out.refjobs[eid] = c;
      else if (parts[2] === "AGENDA") out.agenda[eid] = c;
      else if (parts[2] === "MEAL") out.meals.push({ eid, mid: parts[3], ...c });
    }
    else if (sk.startsWith("FAMILY#")) out.family[sk.slice(7)] = c;
    else if (sk.startsWith("LEDGER#")) { if (showFund) out.ledger.push({ lid: sk.slice(7), ...c }); }
    else if (sk.startsWith("PAYMENT#")) {
      const mine = c.submittedBy === access.caller.sub || (c.pid && c.pid === access.member?.pid);
      if (finance || mine) out.payments.push({ payId: sk.slice(8), ...c });
    }
    else if (sk.startsWith("ANN#")) out.announcements.push({ aid: sk.slice(4), ...c });
    else if (sk.startsWith("TASK#")) out.tasks.push({ kid: sk.slice(5), ...c });
    else if (sk.startsWith("MEMBER#")) {
      // The member id always comes from the key: memberships written at sign-up in Phase 1 have no "sub" attribute.
      const { email, invitedBy, ...pub } = c as Record<string, unknown>;
      const withId = { ...pub, sub: sk.slice(7) };
      out.members.push(accounts ? { ...withId, email, invitedBy } : withId);
    }
  }
  for (const p of out.players) {
    const ct = contacts[String(p.pid)] as { parents?: unknown } | undefined;
    if (ct) p.parents = ct.parents ?? [];
  }
  return out;
}

export function teamRoutes(r: Router) {
  /** Teams in the clubs you run (every club for site owners), with your roles on each. */
  r.on("GET", "/teams", async ({ caller }) => {
    const [adminOf, mine, owner] = await Promise.all([
      queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :c)", ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":c": "CLUB#" } }),
      queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)", ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":t": "TEAM#" } }),
      isPlatformAdmin(caller.sub)
    ]);
    let clubIds = adminOf.map((a) => String(a.GSI1SK).slice(5));
    if (await getItem(keys.clubAdmin(DEFAULT_CLUB(), caller.sub))) clubIds.push(DEFAULT_CLUB());
    if (owner) clubIds = (await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": "CLUBS" } })).map((c) => String(c.SK).slice(5));
    const roles = new Map(mine.filter((m) => m.status === "active").map((m) => [String(m.GSI1SK).slice(5), m.roles]));
    const teams: Record<string, unknown>[] = [];
    for (const clubId of new Set(clubIds)) {
      const dir = await queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" } });
      teams.push(...dir.map((d) => ({ teamId: String(d.SK).slice(5), ...clean(d), clubId, yourRoles: roles.get(String(d.SK).slice(5)) ?? [] })));
    }
    return json(200, { teams });
  });

  r.on("POST", "/teams", async ({ caller, body }) => {
    const b = parseBody(createTeamSchema, body);
    const clubId = b.clubId ?? DEFAULT_CLUB();
    await loadClubAccess(caller, clubId).catch(() => { throw forbidden("Only club admins can create teams."); });
    if (!(await getClub(clubId))) throw notFound("That club doesn't exist.");
    if (b.copyFrom) {
      // Only copy from a team in a club you run.
      const from = await loadAccess(caller, b.copyFrom).catch(() => null);
      if (!from?.clubAdmin) throw forbidden("You can only copy from a team in a club you run.");
    }
    let src: Record<string, unknown> = {};
    let hb: Record<string, unknown> = { sections: [] };
    if (b.copyFrom) {
      src = (await getItem(keys.settings(b.copyFrom))) ?? {};
      hb = (await getItem(keys.handbook(b.copyFrom))) ?? hb;
    }
    const copy = new Set(b.copy);
    const at = now();
    const settings = {
      ...keys.settings(b.teamId), type: "Settings",
      teamName: b.name, season: b.season ?? "", age: b.age ?? "", coaches: b.coaches, teamCode: "",
      dues: copy.has("money") ? (src.dues ?? {}) : { amountCents: 0, due: "", label: "Team fund deposit" },
      budget: copy.has("money") ? (src.budget ?? {}) : { costPerMealCents: 2000, mealsPerDay: 2, people: 15 },
      practices: copy.has("practices") ? (src.practices ?? []) : [],
      cancelled: [],
      checklist: copy.has("lists") && Array.isArray(src.checklist) ? src.checklist : DEFAULT_CHECKLIST,
      uniformItems: copy.has("lists") && Array.isArray(src.uniformItems) ? src.uniformItems : [],
      updatedAt: at, updatedBy: caller.sub
    };
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          // Team ids are unique across every club: the team's own records are keyed by the id alone.
          { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: { ...keys.teamClub(b.teamId), type: "TeamClub", clubId, at } } },
          { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: {
            ...keys.teamDir(clubId, b.teamId), type: "Team", name: b.name, season: b.season ?? "", age: b.age ?? "",
            coaches: b.coaches.map((c) => c.name), archived: false, createdAt: at, createdBy: caller.sub } } },
          { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: settings } },
          { Put: { TableName: TABLE, Item: { ...keys.handbook(b.teamId), type: "Handbook", sections: copy.has("handbook") ? (hb.sections ?? []) : [], updatedAt: at } } }
        ]
      }));
    } catch (e) { mapDbError(e, "A team with that id already exists. Team ids have to be unique across all clubs."); }
    return json(201, { teamId: b.teamId, clubId });
  });

  r.on("GET", "/teams/{teamId}", async ({ caller, params }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    const items = await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${access.teamId}` } });
    // Club admins and site owners pass the access check for any id; there has to be a team to open.
    if (!items.length) throw notFound("There's no team with that id. It may have been deleted.");
    const [dir, clubs] = await Promise.all([getItem(keys.teamDir(access.clubId, access.teamId)), getClubs([access.clubId])]);
    return json(200, { ...bundle(items, access), team: clean(dir) ?? null, club: clubs.get(access.clubId) ?? null });
  });

  r.on("PUT", "/teams/{teamId}/settings", async ({ caller, params, body }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("settings");
    const b = parseBody(settingsSchema, body);
    const at = now();
    const saved = await getItem(keys.settings(access.teamId));
    const practices = b.practices ?? (saved?.practices as unknown[] | undefined) ?? [];
    const cancelled = b.cancelled ?? (saved?.cancelled as unknown[] | undefined) ?? [];
    const budget = b.budget ?? (saved?.budget as Record<string, number> | undefined) ?? {};
    const practiceColors = b.practiceColors ?? (saved?.practiceColors as string[] | undefined) ?? [];
    const dir = (await getItem(keys.teamDir(access.clubId, access.teamId))) ?? { ...keys.teamDir(access.clubId, access.teamId), type: "Team", archived: false, createdAt: at };
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...keys.settings(access.teamId), type: "Settings", ...saved, ...b, practices, cancelled, budget, practiceColors, updatedAt: at, updatedBy: caller.sub } } },
        { Put: { TableName: TABLE, Item: { ...dir, name: b.teamName, season: b.season ?? "", age: b.age ?? "", coaches: b.coaches.map((c) => c.name) } } }
      ]
    }));
    return json(200, { ok: true });
  });

  // ---------- practices (coaches, coordinators, admins) ----------
  r.on("PUT", "/teams/{teamId}/practices", async ({ caller, params, body }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("schedule");
    const { practices } = parseBody(practicesSchema, body);
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: keys.settings(access.teamId),
        UpdateExpression: "SET practices = :p, updatedAt = :at, updatedBy = :by",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":p": practices, ":at": now(), ":by": caller.sub }
      }));
    } catch (e) { mapDbError(e, "This team has no settings yet."); }
    return json(200, { practices });
  });

  /** One-time move of the weekly practice times onto the schedule as practice series (answers carry over). */
  r.on("POST", "/teams/{teamId}/practices/convert", async ({ caller, params }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("schedule");
    return json(200, await convertPractices(access.teamId, caller.sub));
  });

  /** Cancel (PUT) or restore (DELETE) one practice date. Key: pr-<practiceId>-<YYYY-MM-DD>. */
  for (const method of ["PUT", "DELETE"] as const) {
    r.on(method, "/teams/{teamId}/practices/cancelled/{key}", async ({ caller, params }) => {
      const access = await loadAccess(caller, checkId(params.teamId, "team"));
      access.require("schedule");
      const key = checkId(params.key, "practice");
      if (!/^pr-.+-\d{4}-\d{2}-\d{2}$/.test(key) || key.length > 80) throw badRequest("That isn't a practice date.");
      // Read, change, write back only if nobody else saved in between (retry a few times if they did).
      for (let attempt = 0; attempt < 8; attempt++) {
        const saved = await getItem(keys.settings(access.teamId));
        if (!saved) throw notFound("This team has no settings yet.");
        const list = new Set((saved.cancelled as string[] | undefined) ?? []);
        if (method === "PUT") list.add(key); else list.delete(key);
        if (list.size > MAX_CANCELLED) throw conflict("Too many cancelled practices. Remove old ones first.");
        try {
          await ddb.send(new UpdateCommand({
            TableName: TABLE, Key: keys.settings(access.teamId),
            // A counter, not a timestamp: two saves in the same millisecond would look identical.
            UpdateExpression: "SET cancelled = :c, cancelledVersion = :next, updatedAt = :at, updatedBy = :by",
            ConditionExpression: saved.cancelledVersion === undefined ? "attribute_not_exists(cancelledVersion)" : "cancelledVersion = :prev",
            ExpressionAttributeValues: {
              ":c": [...list], ":next": Number(saved.cancelledVersion ?? 0) + 1, ":at": now(), ":by": caller.sub,
              ...(saved.cancelledVersion === undefined ? {} : { ":prev": saved.cancelledVersion })
            }
          }));
          return json(200, { key, cancelled: method === "PUT" });
        } catch (e) {
          if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
        }
      }
      throw conflict("Someone else is changing the schedule. Try again.");
    });
  }

  // ---------- archive, restore and delete (site owners) ----------
  async function ownedTeam(caller: { sub: string }, rawId: string) {
    const teamId = checkId(rawId, "team");
    if (!(await isPlatformAdmin(caller.sub))) throw forbidden("Only site owners can archive or delete teams.");
    const clubId = await clubOfTeam(teamId);
    const [dir, settings] = await Promise.all([getItem(keys.teamDir(clubId, teamId)), getItem(keys.settings(teamId))]);
    if (!dir && !settings) throw notFound("There's no team with that id.");
    return { teamId, clubId, dir, settings };
  }

  /** Archive: the team stays, read-only, out of families' team lists. Restore undoes it. */
  for (const [action, archived] of [["archive", true], ["restore", false]] as const) {
    r.on("POST", `/teams/{teamId}/${action}`, async ({ caller, params }) => {
      const { teamId, clubId, dir, settings } = await ownedTeam(caller, params.teamId);
      const at = now();
      // Teams made before the club team list existed get an entry now.
      const base = dir ?? { ...keys.teamDir(clubId, teamId), type: "Team", name: settings?.teamName ?? teamId, season: settings?.season ?? "", age: settings?.age ?? "", createdAt: at };
      const { archivedAt: _a, archivedBy: _b, ...rest } = base as Record<string, unknown>;
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: archived ? { ...rest, archived, archivedAt: at, archivedBy: caller.sub } : { ...rest, archived } } },
          // Touching the settings tells anyone with the team open to reload it.
          ...(settings ? [{ Update: { TableName: TABLE, Key: keys.settings(teamId), UpdateExpression: "SET archived = :a, updatedAt = :at", ExpressionAttributeValues: { ":a": archived, ":at": at } } }] : [])
        ]
      }));
      return json(200, { teamId, clubId, archived });
    });
  }

  /**
   * Delete a team and everything stored for it: its whole partition, its line in the club's team list and
   * invites still waiting for it. People's accounts stay (they can be on other teams). The body has to repeat
   * the team id, so a stray request can't do it.
   */
  r.on("DELETE", "/teams/{teamId}", async ({ caller, params, body }) => {
    const { teamId, clubId, dir } = await ownedTeam(caller, params.teamId);
    const { confirm } = parseBody(z.object({ confirm: z.string() }), body);
    if (confirm.trim() !== teamId) throw badRequest("Type the team id to confirm.");
    const [records, invites] = await Promise.all([
      queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${teamId}` }, ProjectionExpression: "PK, SK" }),
      queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :t AND begins_with(GSI1SK, :i)", ExpressionAttributeValues: { ":t": `TEAM#${teamId}`, ":i": "INVITE#" }, ProjectionExpression: "PK, SK" })
    ]);
    const key = (i: Record<string, unknown>) => ({ PK: String(i.PK), SK: String(i.SK) });
    // The club link goes last, so a run that stops partway can be repeated and still finds the club.
    const clubLink = records.filter((i) => i.SK === "META#CLUB").map(key);
    const rest = [...(dir ? [keys.teamDir(clubId, teamId)] : []), ...invites.map(key), ...records.filter((i) => i.SK !== "META#CLUB").map(key)];
    await deleteMany(rest);
    await deleteMany(clubLink);
    forgetTeamClubs();
    console.log(JSON.stringify({ msg: "team deleted", teamId, clubId, by: caller.sub, records: rest.length + clubLink.length }));
    // Live connections are left to expire, so people with the team open still hear that it changed.
    return json(200, { teamId, clubId, deleted: rest.length + clubLink.length });
  });

  r.on("PUT", "/teams/{teamId}/handbook", async ({ caller, params, body }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("handbook");
    const b = parseBody(handbookSchema, body);
    await putItem({ ...keys.handbook(access.teamId), type: "Handbook", ...b, updatedAt: now(), updatedBy: caller.sub });
    return json(200, { ok: true });
  });
}
