import { beforeAll, describe, expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { event, freshTable } from "./harness.js";

const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { PERMISSIONS } = await import("../../src/shared/permissions.js");

const T = "t13";
type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string | null, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}

// Callers: one per role, a second parent, a club admin with no membership, and an outsider.
const ROLE_SUBS = { admin: "u-admin", coach: "u-coach", coordinator: "u-coord", food: "u-food", finance: "u-fin", parent: "u-parent" } as const;
const CLUB = "u-club";
const PARENT2 = "u-parent2";
const OUTSIDER = "u-out";

async function member(sub: string, roles: string[], pid = "") {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub,
    email: `${sub}@example.com`, roles, pid, person: "", at: new Date().toISOString() } }));
}

const ok = (s: number) => s >= 200 && s < 300;

beforeAll(async () => {
  await freshTable();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin("a5", CLUB), type: "ClubAdmin" } }));
  const created = await call("POST", "/teams", CLUB, { teamId: T, name: "A5 13 Test", season: "2026-27", age: "13U", coaches: [{ name: "Coach Tom" }] });
  expect(created.status).toBe(201);
  for (const [role, sub] of Object.entries(ROLE_SUBS)) await member(sub, [role], role === "parent" ? "p1" : "");
  await member(PARENT2, ["parent"], "p2");
  for (const pid of ["p1", "p2"]) {
    expect((await call("PUT", `/teams/${T}/players/${pid}`, CLUB, { first: pid.toUpperCase(), parents: [{ name: "Mom", cell: "555" }] })).status).toBe(200);
  }
  expect((await call("PUT", `/teams/${T}/events/e1`, CLUB, { kind: "tournament", title: "Spring Classic", date: "2027-01-09", endDate: "2027-01-10", travel: true })).status).toBe(200);
  expect((await call("PUT", `/teams/${T}/events/e1/meals/m1`, CLUB, { day: "2027-01-09", meal: "Lunch", costCents: 30000 })).status).toBe(200);
});

describe("access basics", () => {
  it("rejects calls with no signed-in user", async () => {
    expect((await call("GET", "/me", null)).status).toBe(401);
  });
  it("keeps non-members out of a team", async () => {
    expect((await call("GET", `/teams/${T}`, OUTSIDER)).status).toBe(403);
  });
  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    expect((await call("GET", "/nope", ROLE_SUBS.admin)).status).toBe(404);
    expect((await call("DELETE", "/me", ROLE_SUBS.admin)).status).toBe(405);
  });
  it("validates bodies", async () => {
    const r = await call("PUT", `/teams/${T}/events/bad`, ROLE_SUBS.coach, { kind: "tournament", title: "X", date: "Jan 9" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/date/);
  });
  it("only club admins create teams", async () => {
    expect((await call("POST", "/teams", ROLE_SUBS.admin, { teamId: "t14", name: "Nope" })).status).toBe(403);
    expect((await call("POST", "/teams", CLUB, { teamId: T, name: "Dup" })).status).toBe(409);
  });
});

describe("role matrix: each route allows exactly the roles in the permission table", () => {
  type Case = { perm: keyof typeof PERMISSIONS; method: string; path: (i: number) => string; body: unknown };
  const cases: Case[] = [
    { perm: "settings", method: "PUT", path: () => `/teams/${T}/settings`, body: { teamName: "A5 13 Test", season: "2026-27", age: "13U", coaches: [{ name: "Coach Tom" }] } },
    { perm: "handbook", method: "PUT", path: () => `/teams/${T}/handbook`, body: { sections: [{ t: "Attendance", b: "Be there." }] } },
    { perm: "roster", method: "PUT", path: (i) => `/teams/${T}/players/px${i}`, body: { first: "Test" } },
    { perm: "schedule", method: "PUT", path: (i) => `/teams/${T}/events/ex${i}`, body: { kind: "event", title: "Party", date: "2026-12-01" } },
    { perm: "schedule", method: "PUT", path: () => `/teams/${T}/practices`, body: { practices: [{ id: "tue", label: "Practice", dow: 2, start: "7:00 PM", from: "2026-11-03" }] } },
    { perm: "schedule", method: "PUT", path: (i) => `/teams/${T}/practices/cancelled/pr-tue-2026-11-${String(i % 28 + 1).padStart(2, "0")}`, body: undefined },
    { perm: "refjobs", method: "PUT", path: () => `/teams/${T}/events/e1/refjobs`, body: { assign: { p1: { s1: "Book" } } } },
    { perm: "meals", method: "PUT", path: (i) => `/teams/${T}/events/e1/meals/mx${i}`, body: { meal: "Dinner" } },
    { perm: "announce", method: "PUT", path: (i) => `/teams/${T}/announcements/a${i}`, body: { text: "Hello" } },
    { perm: "tasks", method: "PUT", path: (i) => `/teams/${T}/tasks/k${i}`, body: { title: "Book hotel" } },
    { perm: "finance", method: "PUT", path: (i) => `/teams/${T}/ledger/l${i}`, body: { kind: "in", cat: "Dues", amountCents: 40000, date: "2026-10-01", desc: "Deposit" } },
    { perm: "accounts", method: "GET", path: () => `/teams/${T}/invites`, body: undefined },
    { perm: "accounts", method: "POST", path: (i) => `/teams/${T}/invites`, body: undefined } // body set per role below
  ];

  let i = 0;
  for (const c of cases) {
    for (const [role, sub] of Object.entries(ROLE_SUBS)) {
      const allowed = (PERMISSIONS[c.perm].roles as readonly string[]).includes(role);
      it(`${c.method} ${c.path(0).replace(/x?\d+$/, "…")} as ${role} → ${allowed ? "allowed" : "403"}`, async () => {
        i++;
        const body = c.body ?? (c.method === "POST" ? { email: `new${i}@example.com`, roles: ["parent"] } : undefined);
        const r = await call(c.method, c.path(i), sub, body);
        if (allowed) expect(ok(r.status), `${r.status} ${JSON.stringify(r.body)}`).toBe(true);
        else expect(r.status).toBe(403);
      });
    }
  }

  it("club admins have team-admin rights without a membership", async () => {
    expect((await call("PUT", `/teams/${T}/tasks/kc`, CLUB, { title: "x" })).status).toBe(200);
    expect((await call("GET", `/teams/${T}/invites`, CLUB)).status).toBe(200);
  });
});

describe("family answers", () => {
  it("a parent answers availability for their own player only", async () => {
    expect((await call("PUT", `/teams/${T}/family/p1`, ROLE_SUBS.parent, { rsvp: { "pr-sat-2026-10-03": "yes" } })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/family/p2`, ROLE_SUBS.parent, { rsvp: { "pr-sat-2026-10-03": "yes" } })).status).toBe(403);
  });
  it("coaches can mark any player's availability but not their travel", async () => {
    expect((await call("PUT", `/teams/${T}/family/p2`, ROLE_SUBS.coach, { rsvp: { e1: "maybe" } })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/family/p2`, ROLE_SUBS.coach, { travel: { e1: { mode: "Driving" } } })).status).toBe(403);
  });
  it("stores, merges and clears answers", async () => {
    await call("PUT", `/teams/${T}/family/p1`, ROLE_SUBS.parent, { travel: { e1: { mode: "Flying", hotel: "Hilton" } }, uniform: { sizes: { "0": "M" } } });
    await call("PUT", `/teams/${T}/family/p1`, ROLE_SUBS.parent, { rsvp: { e1: "no" } });
    let fam = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.family.p1;
    expect(fam.rsvp["pr-sat-2026-10-03"].v).toBe("yes");
    expect(fam.rsvp.e1.v).toBe("no");
    expect(fam.travel.e1).toMatchObject({ mode: "Flying", hotel: "Hilton", by: ROLE_SUBS.parent });
    expect(fam.uniform.sizes).toEqual({ "0": "M" });
    await call("PUT", `/teams/${T}/family/p1`, ROLE_SUBS.parent, { rsvp: { e1: "" }, travel: { e1: null } });
    fam = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.family.p1;
    expect(fam.rsvp.e1).toBeUndefined();
    expect(fam.travel.e1).toBeUndefined();
  });
  it("refuses unknown players", async () => {
    expect((await call("PUT", `/teams/${T}/family/zz`, ROLE_SUBS.coach, { rsvp: { e1: "yes" } })).status).toBe(404);
  });
});

describe("practices", () => {
  const P = { id: "wed", label: "Wednesday practice", dow: 3, start: "6:30 PM", end: "8:30 PM", from: "2026-11-04", until: "2027-03-31", location: "A5 Gym" };
  it("coaches set practice times; cancel and restore single dates", async () => {
    expect((await call("PUT", `/teams/${T}/practices`, ROLE_SUBS.coach, { practices: [P] })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/practices/cancelled/pr-wed-2026-11-11`, ROLE_SUBS.coach)).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/practices/cancelled/pr-wed-2026-11-18`, ROLE_SUBS.coordinator)).status).toBe(200);
    let s = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.settings;
    expect(s.practices).toEqual([P]);
    expect(s.cancelled).toEqual(expect.arrayContaining(["pr-wed-2026-11-11", "pr-wed-2026-11-18"]));
    expect((await call("DELETE", `/teams/${T}/practices/cancelled/pr-wed-2026-11-11`, ROLE_SUBS.coach)).status).toBe(200);
    s = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.settings;
    expect(s.cancelled).not.toContain("pr-wed-2026-11-11");
    expect(s.cancelled).toContain("pr-wed-2026-11-18");
  });
  it("parents can't change practices, and keys must be practice dates", async () => {
    expect((await call("PUT", `/teams/${T}/practices/cancelled/pr-wed-2026-11-25`, ROLE_SUBS.parent)).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/practices/cancelled/e1`, ROLE_SUBS.coach)).status).toBe(400);
  });
  it("cancelling at the same time from two screens keeps both", async () => {
    const keysToCancel = ["pr-wed-2026-12-02", "pr-wed-2026-12-09", "pr-wed-2026-12-16", "pr-wed-2026-12-23"];
    const rs = await Promise.all(keysToCancel.map((k) => call("PUT", `/teams/${T}/practices/cancelled/${k}`, ROLE_SUBS.coach)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const s = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.settings;
    expect(s.cancelled).toEqual(expect.arrayContaining(keysToCancel));
  });
  it("saving team settings without practices keeps them", async () => {
    expect((await call("PUT", `/teams/${T}/settings`, ROLE_SUBS.admin, { teamName: "A5 13 Test", season: "2026-27", age: "13U", coaches: [{ name: "Coach Tom" }] })).status).toBe(200);
    const s = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.settings;
    expect(s.practices).toEqual([P]);
    expect(s.cancelled).toContain("pr-wed-2026-11-18");
  });
});

describe("meal claims", () => {
  it("first family wins; others get 409; only that family or food can release", async () => {
    const path = `/teams/${T}/events/e1/meals/m1/claim`;
    expect((await call("POST", path, ROLE_SUBS.parent, { pid: "p2" })).status).toBe(403);
    expect((await call("POST", path, ROLE_SUBS.parent, { pid: "p1" })).status).toBe(200);
    expect((await call("POST", path, PARENT2, { pid: "p2" })).status).toBe(409);
    expect((await call("DELETE", path, PARENT2)).status).toBe(403);
    expect((await call("DELETE", path, ROLE_SUBS.food)).status).toBe(200);
    expect((await call("POST", path, PARENT2, { pid: "p2" })).status).toBe(200);
  });
  it("editing a meal keeps its claim", async () => {
    await call("PUT", `/teams/${T}/events/e1/meals/m1`, ROLE_SUBS.food, { meal: "Lunch", plan: "Chick-fil-A" });
    const meal = (await call("GET", `/teams/${T}`, ROLE_SUBS.food)).body.meals.find((m: any) => m.mid === "m1");
    expect(meal).toMatchObject({ claimedBy: "p2", plan: "Chick-fil-A" });
  });
});

describe("payments", () => {
  it("parents record dues for their own player; confirm copies to the ledger exactly once", async () => {
    expect((await call("POST", `/teams/${T}/payments`, ROLE_SUBS.parent, { kind: "in", cat: "Dues", pid: "p2", amountCents: 40000, date: "2026-10-01", desc: "Venmo" })).status).toBe(403);
    const made = await call("POST", `/teams/${T}/payments`, ROLE_SUBS.parent, { kind: "in", cat: "Dues", pid: "p1", amountCents: 40000, date: "2026-10-01", desc: "Venmo" });
    expect(made.status).toBe(201);
    const payId = made.body.payId;

    expect((await call("POST", `/teams/${T}/payments/${payId}/confirm`, ROLE_SUBS.parent)).status).toBe(403);
    const conf = await call("POST", `/teams/${T}/payments/${payId}/confirm`, ROLE_SUBS.finance);
    expect(conf.status).toBe(200);
    expect((await call("POST", `/teams/${T}/payments/${payId}/confirm`, ROLE_SUBS.finance)).status).toBe(409);
    expect((await call("DELETE", `/teams/${T}/payments/${payId}`, ROLE_SUBS.parent)).status).toBe(409);

    const team = (await call("GET", `/teams/${T}`, ROLE_SUBS.finance)).body;
    const ledger = team.ledger.filter((l: any) => l.src === payId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amountCents: 40000, cat: "Dues", pid: "p1", status: "confirmed" });
  });

  it("anyone can ask to be paid back; only the sender or finance can withdraw", async () => {
    const r = await call("POST", `/teams/${T}/payments`, ROLE_SUBS.coach, { kind: "out", cat: "Reimbursement", amountCents: 2599, date: "2026-10-02", desc: "Coach snacks" });
    expect(r.status).toBe(201);
    expect((await call("DELETE", `/teams/${T}/payments/${r.body.payId}`, ROLE_SUBS.parent)).status).toBe(403);
    expect((await call("DELETE", `/teams/${T}/payments/${r.body.payId}`, ROLE_SUBS.coach)).status).toBe(204);
  });

  it("families only see their own payments; finance sees all", async () => {
    await call("POST", `/teams/${T}/payments`, PARENT2, { kind: "in", cat: "Dues", pid: "p2", amountCents: 100, date: "2026-10-03", desc: "x" });
    const mine = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.payments;
    expect(mine.every((p: any) => p.pid === "p1" || p.submittedBy === ROLE_SUBS.parent)).toBe(true);
    const all = (await call("GET", `/teams/${T}`, ROLE_SUBS.finance)).body.payments;
    expect(all.some((p: any) => p.pid === "p2")).toBe(true);
  });
});

describe("team bundle", () => {
  it("groups the partition and merges contacts into players", async () => {
    const b = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body;
    expect(b.team).toMatchObject({ name: "A5 13 Test", age: "13U" });
    expect(b.settings.teamName).toBe("A5 13 Test");
    expect(b.players.find((p: any) => p.pid === "p1").parents[0]).toMatchObject({ name: "Mom" });
    expect(b.events.some((e: any) => e.eid === "e1")).toBe(true);
    expect(b.refjobs.e1.assign.p1.s1).toBe("Book");
    expect(b.you).toMatchObject({ sub: ROLE_SUBS.parent, pid: "p1", roles: ["parent"] });
    expect(JSON.stringify(b)).not.toMatch(/"PK"|"GSI1PK"/);
  });
  it("hides member emails from non-admins", async () => {
    const asParent = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.members;
    const asAdmin = (await call("GET", `/teams/${T}`, ROLE_SUBS.admin)).body.members;
    expect(asParent.every((m: any) => m.email === undefined)).toBe(true);
    expect(asAdmin.every((m: any) => typeof m.email === "string")).toBe(true);
  });
  it("deleting an event removes its ref jobs, agenda and meals", async () => {
    await call("PUT", `/teams/${T}/events/e9`, ROLE_SUBS.coach, { kind: "tournament", title: "Gone", date: "2027-02-01" });
    await call("PUT", `/teams/${T}/events/e9/refjobs`, ROLE_SUBS.coach, { assign: {} });
    await call("PUT", `/teams/${T}/events/e9/meals/mm`, ROLE_SUBS.food, { meal: "Lunch" });
    expect((await call("DELETE", `/teams/${T}/events/e9`, ROLE_SUBS.coach)).status).toBe(204);
    const b = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body;
    expect(b.events.some((e: any) => e.eid === "e9")).toBe(false);
    expect(b.refjobs.e9).toBeUndefined();
    expect(b.meals.some((m: any) => m.eid === "e9")).toBe(false);
  });
});

describe("invites and members", () => {
  it("an invite for an existing account is accepted the next time they load /me", async () => {
    const newcomer = "u-new";
    const email = "newcomer@example.com";
    expect((await call("GET", `/teams/${T}`, newcomer)).status).toBe(403);
    expect((await call("POST", `/teams/${T}/invites`, ROLE_SUBS.admin, { email: "Newcomer@Example.com", roles: ["coach"] })).status).toBe(201);
    const me = await call("GET", "/me", newcomer, undefined, email);
    expect(me.status).toBe(200);
    expect(me.body.acceptedInvites).toBe(1);
    expect(me.body.teams.find((t: any) => t.teamId === T).roles).toEqual(["coach"]);
    expect((await call("PUT", `/teams/${T}/tasks/knew`, newcomer, { title: "x" })).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/events/enew`, newcomer, { kind: "event", title: "x", date: "2026-11-01" })).status).toBe(200);
    const invites = (await call("GET", `/teams/${T}/invites`, ROLE_SUBS.admin)).body.invites;
    expect(invites.some((i: any) => i.email === email)).toBe(false);
  });

  it("refuses to invite someone already on the team", async () => {
    expect((await call("POST", `/teams/${T}/invites`, ROLE_SUBS.admin, { email: "u-coach@example.com", roles: ["parent"] })).status).toBe(409);
  });

  it("changes roles, and won't remove the last team admin", async () => {
    expect((await call("PUT", `/teams/${T}/members/${ROLE_SUBS.food}`, ROLE_SUBS.admin, { roles: ["food", "parent"], pid: "p2" })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/members/${ROLE_SUBS.admin}`, ROLE_SUBS.admin, { roles: ["parent"] })).status).toBe(409);
    expect((await call("DELETE", `/teams/${T}/members/${ROLE_SUBS.admin}`, ROLE_SUBS.admin)).status).toBe(409);
    expect((await call("PUT", `/teams/${T}/members/${ROLE_SUBS.food}`, ROLE_SUBS.coach, { roles: ["admin"] })).status).toBe(403);
    // A club admin may override.
    expect((await call("DELETE", `/teams/${T}/members/u-new`, CLUB)).status).toBe(204);
  });

  it("manages Phase 1 memberships that have no sub attribute", async () => {
    const legacy = "u-legacy";
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      ...keys.member(T, legacy), GSI1PK: `USER#${legacy}`, GSI1SK: `TEAM#${T}`, type: "Membership", status: "active",
      email: "legacy@example.com", roles: ["parent"], pid: "p2", person: "", invitedBy: "", at: "2026-09-27T20:00:00Z" } }));
    const members = (await call("GET", `/teams/${T}`, ROLE_SUBS.admin)).body.members;
    expect(members.find((m: any) => m.email === "legacy@example.com")?.sub).toBe(legacy);
    expect((await call("GET", `/teams/${T}/members`, ROLE_SUBS.admin)).body.members.find((m: any) => m.email === "legacy@example.com")?.sub).toBe(legacy);
    expect((await call("PUT", `/teams/${T}/members/${legacy}`, ROLE_SUBS.admin, { roles: ["parent", "food"] })).status).toBe(200);
    expect((await call("DELETE", `/teams/${T}/members/${legacy}`, ROLE_SUBS.admin)).status).toBe(204);
  });

  it("/me for a configured club-admin email creates the admin record", async () => {
    const me = await call("GET", "/me", "u-club2", undefined, "club@example.com");
    expect(me.body.clubAdmin).toBe(true);
  });

  it("lists teams with the caller's roles", async () => {
    const r = await call("GET", "/teams", ROLE_SUBS.finance);
    expect(r.body.teams.find((t: any) => t.teamId === T)).toMatchObject({ name: "A5 13 Test", yourRoles: ["finance"] });
  });
});
