import { markPaused } from "../../lib/feed/sync.js";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { effective, type TeamComms } from "../../shared/messages.js";
import { ddb, TABLE } from "../../lib/db.js";
import { clubOfTeam, DEFAULT_CLUB, forgetTeamClubs, getClub, getClubs } from "../../lib/clubs.js";
import { keys } from "../../lib/keys.js";
import { convertPractices } from "../../lib/practices.js";
import { fundSummary, type FundSummary } from "../../lib/fund.js";
import { CLUB_FEATURES, clubAllows, FEATURE_KEYS, type Feature } from "../../shared/features.js";
import { failedAt, placeRefusal, publicControls, releaseTeamPlace, takeTeamPlace } from "../../lib/club-controls.js";
import { ARCHIVE_DAYS, DELETE_GRACE_DAYS, daysFrom, purgeDate } from "../../lib/retention.js";
import { isPlatformAdmin, loadAccess, loadClubAccess, requirePlatformAdmin, type Caller } from "../context.js";
import { badRequest, conflict, forbidden, json, mapDbError, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, clean, deleteMany, getItem, now, optStr, putItem, queryAll, str } from "../util.js";

/** Weekly practices' first and last dates: YYYY-MM-DD, and anything else saved as blank (a bad date would never end the date loop). */
const optDate = optStr(10).transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined));
const coach = z.object({ name: str(100), phone: optStr(40) });
const practice = z.object({
  id: str(40), label: str(100), dow: z.number().int().min(0).max(6),
  start: optStr(20), end: optStr(20), from: optDate, until: optDate, location: optStr(200), note: optStr(300)
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
  practiceColors: z.array(str(40).min(1)).max(20).optional(),
  /** Practice attendance: do excused absences lower the percentage? Left out = keep what's saved (default yes). */
  attendanceExcusedCounts: z.boolean().optional()
});

/** Every feature can be listed; true = on. Features left out keep their saved setting. */
const featuresSchema = z.object({ features: z.record(z.enum(FEATURE_KEYS as [Feature, ...Feature[]]), z.boolean()) });

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
/**
 * Everything a member's browser gets for one team, trimmed to what their roles allow (R3):
 * - every family's phone numbers and emails: staff, plus families who chose to share (shareContacts);
 * - allergies: admins, coaches, coordinators and food, plus the player's own parents;
 * - travel plans and uniform sizes: the family itself and admins/coordinators. Others see only
 *   that a family has entered them, so counts still work;
 * - every fund entry: finance, coordinators and admins. Others get the totals and their own entries.
 * Features the team has turned off are left out for everyone; their data stays saved for if they're
 * turned back on.
 */
export function bundle(items: Record<string, unknown>[], access: Awaited<ReturnType<typeof loadAccess>>) {
  const out = {
    teamId: access.teamId,
    you: { sub: access.caller.sub, roles: [...access.roles], pid: access.member?.pid ?? "", person: access.member?.person ?? "", clubAdmin: access.clubAdmin, siteOwner: access.platformAdmin },
    clubId: access.clubId,
    settings: null as unknown, handbook: null as unknown,
    players: [] as Record<string, unknown>[], events: [] as unknown[], meals: [] as unknown[],
    refjobs: {} as Record<string, unknown>, matches: {} as Record<string, unknown>, agenda: {} as Record<string, unknown>,
    family: {} as Record<string, unknown>, ledger: [] as unknown[], payments: [] as unknown[],
    announcements: [] as unknown[], tasks: [] as unknown[], members: [] as unknown[],
    /** Practice attendance: every player's marks for staff who take it, only their own player's for a family. */
    attendance: [] as Record<string, unknown>[],
    /** Present when the ledger was trimmed: the team's totals, which the browser can no longer add up. */
    fundSummary: undefined as FundSummary | undefined,
    /** Calendar feed sync health, for the team's feed admins (team admins and coordinators). */
    feedStatus: undefined as { attention: boolean; failures: number; paused: boolean; lastOkAt: unknown } | undefined
  };
  const contacts: Record<string, unknown> = {};
  const allContacts = access.can("contacts");
  const allAllergies = access.can("allergies");
  const allFamilies = access.can("roster");
  const showFund = access.can("fundView");
  const fullLedger = access.can("ledger");
  const finance = access.can("finance");
  const accounts = access.can("accounts");
  const myPid = access.isParentOf(access.member?.pid) ? String(access.member!.pid) : "";
  const attendanceOn = access.has("attendance");
  const allAttendance = attendanceOn && access.can("takeAttendance");
  const allLedger: Record<string, unknown>[] = [];
  const allPayments: Record<string, unknown>[] = [];

  for (const it of items) {
    const sk = String(it.SK);
    const c = clean(it)!;
    if (sk === "META#SETTINGS") out.settings = c;
    else if (sk === "META#HANDBOOK") out.handbook = c;
    // Calendar feed health for whoever looks after the feed (never the link itself).
    else if (sk === "FEED#SOURCE") {
      if (access.can("calendarFeed") && it.importedAt) out.feedStatus = { attention: !!it.attention, failures: Number(it.failures ?? 0), paused: !!it.pausedSince, lastOkAt: it.lastOkAt ?? null };
    }
    else if (sk.startsWith("META#")) continue;
    else if (sk.startsWith("PLAYER#") && sk.endsWith("#CONTACTS")) contacts[sk.slice(7, -9)] = c;
    else if (sk.startsWith("PLAYER#")) {
      const pid = sk.slice(7);
      const p: Record<string, unknown> = { pid, ...c };
      if (!allAllergies && pid !== myPid) delete p.allergies;
      out.players.push(p);
    }
    else if (sk.startsWith("EVENT#")) {
      const parts = sk.split("#"); // EVENT, eid, [REFJOBS|MATCHES|AGENDA|MEAL, mid]
      const eid = parts[1];
      if (parts.length === 2) out.events.push({ eid, ...c });
      else if (parts[2] === "REFJOBS") out.refjobs[eid] = c;
      else if (parts[2] === "MATCHES") out.matches[eid] = c;
      else if (parts[2] === "AGENDA") out.agenda[eid] = c;
      else if (parts[2] === "MEAL") out.meals.push({ eid, mid: parts[3], ...c });
    }
    else if (sk.startsWith("FAMILY#")) {
      const pid = sk.slice(7);
      out.family[pid] = allFamilies || pid === myPid ? c : familySummary(c);
    }
    else if (sk.startsWith("ATT#")) {
      if (allAttendance) out.attendance.push(c);
      else if (attendanceOn && myPid) {
        // A family gets the dates and their own player's mark: never other players' marks, notes or who took it.
        const mine = (c.marks as Record<string, unknown> | undefined)?.[myPid];
        out.attendance.push({ key: c.key, date: c.date, marks: mine ? { [myPid]: mine } : {} });
      }
    }
    else if (sk.startsWith("LEDGER#")) {
      const l: Record<string, unknown> = { lid: sk.slice(7), ...c };
      allLedger.push(l);
      if (fullLedger || (showFund && myPid && l.pid === myPid)) out.ledger.push(l);
    }
    else if (sk.startsWith("PAYMENT#")) {
      allPayments.push(c);
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
    const pid = String(p.pid);
    const shared = (out.family[pid] as { shareContacts?: boolean } | undefined)?.shareContacts === true;
    if (!(allContacts || pid === myPid || shared)) continue;
    const ct = contacts[pid] as { parents?: unknown } | undefined;
    if (ct) p.parents = ct.parents ?? [];
  }
  // Switched-off features: nothing for anyone (the data stays saved).
  if (!access.has("fund")) { out.ledger = []; out.payments = []; }
  if (!access.has("meals")) out.meals = [];
  if (!access.has("refjobs")) out.refjobs = {};
  if (!access.has("matches")) out.matches = {};
  if (!access.has("tasks")) out.tasks = [];
  if (!access.has("handbook")) out.handbook = null;
  if (!access.has("travel")) out.agenda = {};
  if (!access.has("travel") || !access.has("uniforms")) {
    for (const f of Object.values(out.family) as Record<string, unknown>[]) {
      if (!access.has("travel")) f.travel = {};
      if (!access.has("uniforms")) f.uniform = {};
    }
  }
  if (showFund && !fullLedger && access.has("fund")) {
    const dues = (out.settings as { dues?: { amountCents?: number } } | null)?.dues?.amountCents ?? 0;
    out.fundSummary = fundSummary(allLedger, allPayments, out.players.map((p) => String(p.pid)), dues);
  }
  return out;
}

/** Another family's record, for people who may only see that they've answered. */
function familySummary(c: Record<string, unknown>) {
  const travel: Record<string, unknown> = {};
  for (const [eid, t] of Object.entries((c.travel ?? {}) as Record<string, Record<string, unknown> | null>)) {
    if (t) travel[eid] = { entered: true, ...(t.mode ? { mode: t.mode } : {}) };
  }
  const sizes = ((c.uniform as { sizes?: Record<string, string> } | undefined)?.sizes) ?? {};
  return {
    pid: c.pid, rsvp: c.rsvp ?? {}, shareContacts: c.shareContacts === true, travel,
    uniform: { entered: Object.values(sizes).some(Boolean) }
  };
}

export function teamRoutes(r: Router) {
  /** Teams in the clubs you run (every club for site owners), with your roles on each. */
  r.on("GET", "/teams", async ({ caller }) => {
    const [adminOf, mine, owner] = await Promise.all([
      queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :c)", ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":c": "CLUB#" } }),
      queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)", ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":t": "TEAM#" } }),
      isPlatformAdmin(caller)
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
    const { platformAdmin: owner } = await loadClubAccess(caller, clubId).catch((e) => { throw e?.code === "mfa_required" ? e : forbidden("Only club admins can create teams."); });
    if (!(await getClub(clubId))) throw notFound("That club doesn't exist.");
    const refusal = await placeRefusal(clubId, owner);
    if (refusal) throw conflict(refusal, "team_limit");
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
          { Put: { TableName: TABLE, Item: { ...keys.handbook(b.teamId), type: "Handbook", sections: copy.has("handbook") ? (hb.sections ?? []) : [], updatedAt: at } } },
          // One of the club's team places (site admin dashboard): refused when inactive or at the limit.
          takeTeamPlace(clubId, owner)
        ]
      }));
    } catch (e) {
      if (failedAt(e, 4)) throw conflict((await placeRefusal(clubId, owner)) ?? "Your club can't add a team right now. Try again.", "team_limit");
      mapDbError(e, "A team with that id already exists. Team ids have to be unique across all clubs.");
    }
    return json(201, { teamId: b.teamId, clubId });
  });

  r.on("GET", "/teams/{teamId}", async ({ caller, params }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    const items = await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${access.teamId}` } });
    // Club admins and site owners pass the access check for any id; there has to be a team to open.
    if (!items.length) throw notFound("There's no team with that id. It may have been deleted.");
    const [dir, clubs] = await Promise.all([getItem(keys.teamDir(access.clubId, access.teamId)), getClubs([access.clubId])]);
    // Whether "Also email the team" is offered when posting (Messaging M2b).
    const comms = items.find((i) => i.SK === "META#COMMS") as TeamComms | undefined;
    const emailPosts = effective("announcement", comms)!.on && access.can("announce") && access.club.status === "active" && clubAllows(access.club.features, "email");
    const out = bundle(items, access) as Record<string, unknown> & { settings: Record<string, unknown> | null };
    // Features the team can use (its own switches and its club's), the team's own switches for
    // Team settings, and what the club allows (site admin dashboard).
    if (out.settings) out.settings = { ...out.settings, features: access.features, teamFeatures: access.teamFeatures };
    return json(200, { ...out, team: clean(dir) ?? null, club: clubs.get(access.clubId) ?? null, clubControls: publicControls(access.club), emailPosts });
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

  /** Turn optional features on or off for this team (admins and coordinators). */
  r.on("PUT", "/teams/{teamId}/features", async ({ caller, params, body }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("settings");
    const { features } = parseBody(featuresSchema, body);
    const next: Record<string, boolean> = { ...access.teamFeatures };
    for (const [f, on] of Object.entries(features)) {
      if (on && !clubAllows(access.club.features, f as Feature)) throw conflict(`${CLUB_FEATURES[f as Feature].label} isn't included for your club. A site owner can turn it on.`, "feature_off");
      if (on) delete next[f]; else next[f] = false;
    }
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: keys.settings(access.teamId),
        // Touching updatedAt tells anyone with the team open to reload it.
        UpdateExpression: "SET features = :f, updatedAt = :at, updatedBy = :by",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":f": next, ":at": now(), ":by": caller.sub }
      }));
    } catch (e) { mapDbError(e, "This team has no settings yet."); }
    if (features.calfeed === false) await markPaused(access.teamId);
    console.log(JSON.stringify({ msg: "team features changed", teamId: access.teamId, by: caller.sub, off: Object.keys(next) }));
    return json(200, { features: next });
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
  async function ownedTeam(caller: Caller, rawId: string) {
    const teamId = checkId(rawId, "team");
    await requirePlatformAdmin(caller, "Only site owners can archive or delete teams.");
    const clubId = await clubOfTeam(teamId);
    const [dir, settings] = await Promise.all([getItem(keys.teamDir(clubId, teamId)), getItem(keys.settings(teamId))]);
    if (!dir && !settings) throw notFound("There's no team with that id.");
    return { teamId, clubId, dir, settings };
  }

  /** Archive: the team stays, read-only, out of families' team lists. Restore undoes it. */
  for (const [action, archived] of [["archive", true], ["restore", false]] as const) {
    r.on("POST", `/teams/{teamId}/${action}`, async ({ caller, params }) => {
      const { teamId, clubId, dir, settings } = await ownedTeam(caller, params.teamId);
      // Archiving an archived team changes nothing, so a pending 7-day delete keeps its date.
      if (archived && dir?.archived) return json(200, { teamId, clubId, archived, purgeAt: purgeDate(dir) });
      const at = now();
      // Teams made before the club team list existed get an entry now.
      const base = dir ?? { ...keys.teamDir(clubId, teamId), type: "Team", name: settings?.teamName ?? teamId, season: settings?.season ?? "", age: settings?.age ?? "", createdAt: at };
      const { archivedAt: _a, archivedBy: _b, purgeAt: _p, deleteRequestedAt: _r, deleteRequestedBy: _q, ...rest } = base as Record<string, unknown>;
      // Restoring takes one of the club's team places again; archiving gives one back.
      const restoring = !archived && !!dir?.archived;
      // Only site owners restore teams, so an inactive club doesn't stop it; the limit does.
      if (restoring) { const refusal = await placeRefusal(clubId, true); if (refusal) throw conflict(refusal, "team_limit"); }
      try {
        await ddb.send(new TransactWriteCommand({
          TransactItems: [
            // Archived teams are deleted after 90 days (R4); restoring cancels that and any pending delete.
            { Put: { TableName: TABLE, Item: archived ? { ...rest, archived, archivedAt: at, archivedBy: caller.sub, purgeAt: daysFrom(at, ARCHIVE_DAYS) } : { ...rest, archived } } },
            // Touching the settings tells anyone with the team open to reload it.
            ...(settings ? [{ Update: { TableName: TABLE, Key: keys.settings(teamId), UpdateExpression: "SET archived = :a, updatedAt = :at", ExpressionAttributeValues: { ":a": archived, ":at": at } } }] : []),
            ...(restoring ? [takeTeamPlace(clubId, true)] : [])
          ]
        }));
      } catch (e) {
        if (restoring && failedAt(e, settings ? 2 : 1)) throw conflict((await placeRefusal(clubId, true)) ?? "Your club can't restore a team right now. Try again.", "team_limit");
        throw e;
      }
      if (archived && !dir?.archived) await releaseTeamPlace(clubId);
      return json(200, { teamId, clubId, archived, ...(archived ? { purgeAt: daysFrom(at, ARCHIVE_DAYS) } : {}) });
    });
  }

  /**
   * "Delete team": archives the team now (read-only for everyone) and deletes it for good after 7 days,
   * unless a site owner restores it first (R31). The body has to repeat the team id, so a stray request
   * can't do it. The daily retention job does the deleting (lib/retention.ts).
   */
  r.on("DELETE", "/teams/{teamId}", async ({ caller, params, body }) => {
    const { teamId, clubId, dir, settings } = await ownedTeam(caller, params.teamId);
    const { confirm } = parseBody(z.object({ confirm: z.string() }), body);
    if (confirm.trim() !== teamId) throw badRequest("Type the team id to confirm.");
    const at = now();
    const purgeAt = daysFrom(at, DELETE_GRACE_DAYS);
    const base = dir ?? { ...keys.teamDir(clubId, teamId), type: "Team", name: settings?.teamName ?? teamId, season: settings?.season ?? "", age: settings?.age ?? "", createdAt: at };
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...base, archived: true, archivedAt: (base as Record<string, unknown>).archived ? (base as Record<string, unknown>).archivedAt ?? at : at, archivedBy: (base as Record<string, unknown>).archivedBy ?? caller.sub, purgeAt, deleteRequestedAt: at, deleteRequestedBy: caller.sub } } },
        ...(settings ? [{ Update: { TableName: TABLE, Key: keys.settings(teamId), UpdateExpression: "SET archived = :a, updatedAt = :at", ExpressionAttributeValues: { ":a": true, ":at": at } } }] : [])
      ]
    }));
    if (!dir?.archived) await releaseTeamPlace(clubId);
    console.log(JSON.stringify({ msg: "team delete requested", teamId, clubId, by: caller.sub, purgeAt }));
    return json(200, { teamId, clubId, archived: true, purgeAt });
  });

  r.on("PUT", "/teams/{teamId}/handbook", async ({ caller, params, body }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("handbook");
    access.requireFeature("handbook");
    const b = parseBody(handbookSchema, body);
    await putItem({ ...keys.handbook(access.teamId), type: "Handbook", ...b, updatedAt: now(), updatedBy: caller.sub });
    return json(200, { ok: true });
  });
}
