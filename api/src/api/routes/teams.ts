import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { CLUB_ID, loadAccess } from "../context.js";
import { forbidden, json, mapDbError, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, clean, getItem, now, optStr, putItem, queryAll, str } from "../util.js";

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
  budget: z.record(z.number()).default({}),
  practices: z.array(practice).max(20).default([]),
  cancelled: z.array(str(80)).max(500).default([]),
  checklist: z.array(str(200)).max(60).default([]),
  uniformItems: z.array(str(200)).max(60).default([])
});

const handbookSchema = z.object({ sections: z.array(z.object({ t: str(200), b: str(10_000) })).max(60) });

const createTeamSchema = z.object({
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
      const { email, invitedBy, ...pub } = c as Record<string, unknown>;
      out.members.push(accounts ? { ...pub, email, invitedBy } : pub);
    }
  }
  for (const p of out.players) {
    const ct = contacts[String(p.pid)] as { parents?: unknown } | undefined;
    if (ct) p.parents = ct.parents ?? [];
  }
  return out;
}

export function teamRoutes(r: Router) {
  r.on("GET", "/teams", async ({ caller }) => {
    const [dir, mine] = await Promise.all([
      queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${CLUB_ID()}`, ":t": "TEAM#" } }),
      queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)", ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":t": "TEAM#" } })
    ]);
    const roles = new Map(mine.filter((m) => m.status === "active").map((m) => [String(m.GSI1SK).slice(5), m.roles]));
    return json(200, {
      teams: dir.map((t) => ({ teamId: String(t.SK).slice(5), ...clean(t), yourRoles: roles.get(String(t.SK).slice(5)) ?? [] }))
    });
  });

  r.on("POST", "/teams", async ({ caller, body }) => {
    if (!(await getItem(keys.clubAdmin(CLUB_ID(), caller.sub)))) throw forbidden("Only club admins can create teams.");
    const b = parseBody(createTeamSchema, body);
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
          { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: {
            ...keys.teamDir(CLUB_ID(), b.teamId), type: "Team", name: b.name, season: b.season ?? "", age: b.age ?? "",
            coaches: b.coaches.map((c) => c.name), archived: false, createdAt: at, createdBy: caller.sub } } },
          { Put: { TableName: TABLE, Item: settings } },
          { Put: { TableName: TABLE, Item: { ...keys.handbook(b.teamId), type: "Handbook", sections: copy.has("handbook") ? (hb.sections ?? []) : [], updatedAt: at } } }
        ]
      }));
    } catch (e) { mapDbError(e, "A team with that id already exists."); }
    return json(201, { teamId: b.teamId });
  });

  r.on("GET", "/teams/{teamId}", async ({ caller, params }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    const items = await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${access.teamId}` } });
    const dir = await getItem(keys.teamDir(CLUB_ID(), access.teamId));
    return json(200, { ...bundle(items, access), team: clean(dir) ?? null });
  });

  r.on("PUT", "/teams/{teamId}/settings", async ({ caller, params, body }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("settings");
    const b = parseBody(settingsSchema, body);
    const at = now();
    const dir = (await getItem(keys.teamDir(CLUB_ID(), access.teamId))) ?? { ...keys.teamDir(CLUB_ID(), access.teamId), type: "Team", archived: false, createdAt: at };
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...keys.settings(access.teamId), type: "Settings", ...b, updatedAt: at, updatedBy: caller.sub } } },
        { Put: { TableName: TABLE, Item: { ...dir, name: b.teamName, season: b.season ?? "", age: b.age ?? "", coaches: b.coaches.map((c) => c.name) } } }
      ]
    }));
    return json(200, { ok: true });
  });

  r.on("PUT", "/teams/{teamId}/handbook", async ({ caller, params, body }) => {
    const access = await loadAccess(caller, checkId(params.teamId, "team"));
    access.require("handbook");
    const b = parseBody(handbookSchema, body);
    await putItem({ ...keys.handbook(access.teamId), type: "Handbook", ...b, updatedAt: now(), updatedBy: caller.sub });
    return json(200, { ok: true });
  });
}
