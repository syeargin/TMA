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
    { perm: "refjobs", method: "PUT", path: () => `/teams/${T}/refgroups`, body: { groups: { p1: "A", p2: "B" } } },
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
  it("saving team settings without the meal budget keeps it", async () => {
    const base = { teamName: "A5 13 Test", season: "2026-27", age: "13U", coaches: [{ name: "Coach Tom" }] };
    expect((await call("PUT", `/teams/${T}/settings`, ROLE_SUBS.admin, { ...base, budget: { costPerMealCents: 2500, mealsPerDay: 3, people: 16 } })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/settings`, ROLE_SUBS.coordinator, base)).status).toBe(200);
    const s = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.settings;
    expect(s.budget).toEqual({ costPerMealCents: 2500, mealsPerDay: 3, people: 16 });
  });
  it("saving team settings without practices keeps them", async () => {
    expect((await call("PUT", `/teams/${T}/settings`, ROLE_SUBS.admin, { teamName: "A5 13 Test", season: "2026-27", age: "13U", coaches: [{ name: "Coach Tom" }] })).status).toBe(200);
    const s = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.settings;
    expect(s.practices).toEqual([P]);
    expect(s.cancelled).toContain("pr-wed-2026-11-18");
  });
});

describe("ref groups", () => {
  it("coaches split players into A and B without touching anything else", async () => {
    expect((await call("PUT", `/teams/${T}/refgroups`, ROLE_SUBS.coach, { groups: { p1: "B", p2: "A" } })).status).toBe(200);
    const players = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.players;
    const p1 = players.find((p: any) => p.pid === "p1");
    expect(p1.refTeam).toBe("B");
    expect(p1.first).toBe("P1");
    expect(p1.parents).toEqual([{ name: "Mom", cell: "555" }]);
    expect(players.find((p: any) => p.pid === "p2").refTeam).toBe("A");
  });
  it("refuses unknown players and bad groups", async () => {
    expect((await call("PUT", `/teams/${T}/refgroups`, ROLE_SUBS.coach, { groups: { nobody: "A" } })).status).toBe(409);
    expect((await call("PUT", `/teams/${T}/refgroups`, ROLE_SUBS.coach, { groups: { p1: "C" } })).status).toBe(400);
  });
});

describe("repeating events", () => {
  it("saves a weekly series; tournaments can't repeat; the end can't be before the start", async () => {
    const s = { kind: "event", title: "Skills clinic", date: "2026-11-03", time: "6:00 PM", repeat: { every: 1, days: [4, 2, 2], until: "2026-12-15" } };
    expect((await call("PUT", `/teams/${T}/events/eser`, ROLE_SUBS.coach, s)).status).toBe(200);
    const e = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.events.find((x: any) => x.eid === "eser");
    expect(e.repeat).toEqual({ every: 1, days: [2, 4], until: "2026-12-15", skipTournaments: true });
    expect((await call("PUT", `/teams/${T}/events/eser`, ROLE_SUBS.coach, { ...s, cancelled: ["2026-11-10"] })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/events/tser`, ROLE_SUBS.coach, { ...s, kind: "tournament" })).status).toBe(400);
    expect((await call("PUT", `/teams/${T}/events/eser`, ROLE_SUBS.coach, { ...s, repeat: { ...s.repeat, until: "2026-10-01" } })).status).toBe(400);
  });

  it("combines one-time practices into a series and keeps families' answers", async () => {
    const dates = ["2027-01-05", "2027-01-12", "2027-01-26"];
    for (const [i, d] of dates.entries()) {
      expect((await call("PUT", `/teams/${T}/events/ep${i}`, ROLE_SUBS.coach, { kind: "event", title: "Practice", date: d, time: "7:00 PM", location: "Gym" })).status).toBe(200);
    }
    expect((await call("PUT", `/teams/${T}/family/p1`, ROLE_SUBS.parent, { rsvp: { ep0: "yes", ep2: "no" } })).status).toBe(200);
    const body = { eids: ["ep2", "ep0", "ep1"], repeat: { every: 1, days: [2], until: "2027-01-26" }, skip: ["2027-01-19"] };
    expect((await call("POST", `/teams/${T}/events/combine`, ROLE_SUBS.parent, body)).status).toBe(403);
    const r = await call("POST", `/teams/${T}/events/combine`, ROLE_SUBS.coach, body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ eid: "ep0", combined: 3, answersMoved: 2 });
    const b = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body;
    const mine = b.events.filter((x: any) => /^ep\d$/.test(x.eid));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ eid: "ep0", date: "2027-01-05", time: "7:00 PM", repeat: { every: 1, days: [2], until: "2027-01-26" }, skip: ["2027-01-19"] });
    const rsvp = b.family.p1.rsvp;
    expect(rsvp["ep0-2027-01-05"].v).toBe("yes");
    expect(rsvp["ep0-2027-01-26"].v).toBe("no");
    expect(rsvp.ep0).toBeUndefined();
    expect(rsvp.ep2).toBeUndefined();
  });

  it("won't combine tournaments or events that are already a series", async () => {
    expect((await call("POST", `/teams/${T}/events/combine`, ROLE_SUBS.coach, { eids: ["e1", "ep0"], repeat: { every: 1, days: [2], until: "2027-02-01" } })).status).toBe(400);
  });
});

describe("practice events", () => {
  const PR = { kind: "practice", title: "Team practice", date: "2026-11-03", time: "6:30 PM", endTime: "8:30 PM", location: "A5 Gym", court: "3",
    uniformColor: "Navy", repeat: { every: 2, days: [2], until: "2027-01-26" } };

  it("the team keeps a list of practice uniform colors", async () => {
    const base = { teamName: "A5 13 Test", season: "2026-27", age: "13U", coaches: [{ name: "Coach Tom" }] };
    expect((await call("PUT", `/teams/${T}/settings`, ROLE_SUBS.coordinator, { ...base, practiceColors: ["Navy", "White", "Red"] })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/settings`, ROLE_SUBS.coordinator, base)).status).toBe(200);
    expect((await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.settings.practiceColors).toEqual(["Navy", "White", "Red"]);
  });

  it("saves a practice series with its court, uniform and end time; one date can change on its own", async () => {
    expect((await call("PUT", `/teams/${T}/events/prs`, ROLE_SUBS.parent, PR)).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/events/prs`, ROLE_SUBS.coach, PR)).status).toBe(200);
    const withDate = { ...PR, overrides: { "2026-11-17": { time: "7:00 PM", court: "5", uniformColor: "White", notes: "Gym B this week" } } };
    expect((await call("PUT", `/teams/${T}/events/prs`, ROLE_SUBS.coach, withDate)).status).toBe(200);
    const e = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.events.find((x: any) => x.eid === "prs");
    expect(e).toMatchObject({ kind: "practice", court: "3", uniformColor: "Navy", endTime: "8:30 PM", overrides: { "2026-11-17": { court: "5" } } });
    expect((await call("PUT", `/teams/${T}/events/prs`, ROLE_SUBS.coach, { ...PR, overrides: { "Nov 17": {} } })).status).toBe(400);
    // Single events have no per-date changes.
    expect((await call("PUT", `/teams/${T}/events/one`, ROLE_SUBS.coach, { ...PR, repeat: undefined, overrides: { "2026-11-03": { court: "1" } } })).status).toBe(200);
    expect((await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.events.find((x: any) => x.eid === "one").overrides).toBeUndefined();
  });

  it("splits a series at a date; later cancellations, date changes and answers move to the new series", async () => {
    const withAll = { ...PR, cancelled: ["2026-11-03", "2026-12-15"], overrides: { "2026-11-17": { court: "5" }, "2026-12-29": { notes: "Holiday hours" } } };
    expect((await call("PUT", `/teams/${T}/events/prs`, ROLE_SUBS.coach, withAll)).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/family/p1`, ROLE_SUBS.parent, { rsvp: { "prs-2026-11-17": "yes", "prs-2026-12-29": "maybe" } })).status).toBe(200);
    const later = { ...PR, date: "2026-12-01", time: "5:30 PM", endTime: "7:30 PM", court: "1" };
    expect((await call("POST", `/teams/${T}/events/prs/split`, ROLE_SUBS.coach, { from: "2026-11-03", event: later })).status).toBe(400);
    expect((await call("POST", `/teams/${T}/events/prs/split`, ROLE_SUBS.coach, { from: "2026-12-01", event: { ...later, date: "2026-11-20" } })).status).toBe(400);
    const r = await call("POST", `/teams/${T}/events/prs/split`, ROLE_SUBS.coach, { from: "2026-12-01", event: later });
    expect(r.status).toBe(200);
    expect(r.body.answersMoved).toBe(1);
    const b = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body;
    const first = b.events.find((x: any) => x.eid === "prs");
    const second = b.events.find((x: any) => x.eid === r.body.eid);
    expect(first).toMatchObject({ time: "6:30 PM", court: "3", repeat: { until: "2026-11-30" }, cancelled: ["2026-11-03"], overrides: { "2026-11-17": { court: "5" } } });
    expect(first.overrides["2026-12-29"]).toBeUndefined();
    expect(second).toMatchObject({ kind: "practice", date: "2026-12-01", time: "5:30 PM", court: "1", repeat: { every: 2, until: "2027-01-26" }, cancelled: ["2026-12-15"], overrides: { "2026-12-29": { notes: "Holiday hours" } } });
    expect(b.family.p1.rsvp["prs-2026-11-17"].v).toBe("yes");
    expect(b.family.p1.rsvp[`${r.body.eid}-2026-12-29`].v).toBe("maybe");
    expect(b.family.p1.rsvp["prs-2026-12-29"]).toBeUndefined();
  });

  it("converts the weekly practice times once, keeping cancelled dates and answers", async () => {
    // From the "practices" tests: Wednesday practice with 11-18 and 12-02…12-23 cancelled.
    expect((await call("PUT", `/teams/${T}/family/p1`, ROLE_SUBS.parent, { rsvp: { "pr-wed-2026-11-25": "no" } })).status).toBe(200);
    expect((await call("POST", `/teams/${T}/practices/convert`, ROLE_SUBS.parent)).status).toBe(403);
    const r = await call("POST", `/teams/${T}/practices/convert`, ROLE_SUBS.coach);
    expect(r.body).toEqual({ converted: 1, skipped: [] });
    expect((await call("POST", `/teams/${T}/practices/convert`, ROLE_SUBS.coach)).body.converted).toBe(0);
    const b = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body;
    expect(b.settings.practices).toEqual([]);
    expect(b.settings.cancelled.some((k: string) => k.startsWith("pr-wed-"))).toBe(false);
    const e = b.events.find((x: any) => x.eid === "pr-wed");
    expect(e).toMatchObject({
      kind: "practice", title: "Wednesday practice", date: "2026-11-04", time: "6:30 PM", endTime: "8:30 PM", location: "A5 Gym",
      repeat: { every: 1, days: [3], until: "2027-03-31", skipTournaments: true }
    });
    expect(e.cancelled.sort()).toEqual(["2026-11-18", "2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23"]);
    // The answer's key is already the series date's key.
    expect(b.family.p1.rsvp["pr-wed-2026-11-25"].v).toBe("no");
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

  it("names: the inviter's name lands on the membership; the person can set their own on every team", async () => {
    const sub = "u-named";
    expect((await call("POST", `/teams/${T}/invites`, ROLE_SUBS.admin, { email: "named@example.com", roles: ["parent"], firstName: "Jo", lastName: "Moss", pid: "p1" })).status).toBe(201);
    expect((await call("GET", "/me", sub, undefined, "named@example.com")).body.acceptedInvites).toBe(1);
    let m = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.members.find((x: any) => x.sub === sub);
    expect([m.firstName, m.lastName]).toEqual(["Jo", "Moss"]);
    expect(m.email).toBeUndefined(); // parents still don't see emails

    expect((await call("PUT", "/me", sub, { firstName: "  Joanna ", lastName: "Moss-Lee" })).status).toBe(200);
    const me = (await call("GET", "/me", sub, undefined, "named@example.com")).body;
    expect([me.firstName, me.lastName]).toEqual(["Joanna", "Moss-Lee"]);
    m = (await call("GET", `/teams/${T}`, ROLE_SUBS.coach)).body.members.find((x: any) => x.sub === sub);
    expect([m.firstName, m.lastName]).toEqual(["Joanna", "Moss-Lee"]);
    expect(m.roles).toEqual(["parent"]);
    expect(m.pid).toBe("p1");

    expect((await call("PUT", "/me", sub, { firstName: "", lastName: "X" })).status).toBe(400);
  });

  it("the banner name falls back to a name an admin set, and it sticks to the profile", async () => {
    expect((await call("PUT", `/teams/${T}/members/${ROLE_SUBS.finance}`, ROLE_SUBS.admin, { roles: ["finance"], firstName: "Pat", lastName: "Lee" })).status).toBe(200);
    let me = (await call("GET", "/me", ROLE_SUBS.finance, undefined, "u-fin@example.com")).body;
    expect([me.firstName, me.lastName]).toEqual(["Pat", "Lee"]);
    expect((await call("PUT", "/me", ROLE_SUBS.finance, { firstName: "Patricia", lastName: "Lee" })).status).toBe(200);
    me = (await call("GET", "/me", ROLE_SUBS.finance, undefined, "u-fin@example.com")).body;
    expect(me.firstName).toBe("Patricia");
  });

  it("team admins can correct a member's name; roles and family are kept", async () => {
    expect((await call("PUT", `/teams/${T}/members/${ROLE_SUBS.food}`, ROLE_SUBS.admin, { roles: ["food"], firstName: "Fran", lastName: "Food" })).status).toBe(200);
    const m = (await call("GET", `/teams/${T}`, ROLE_SUBS.admin)).body.members.find((x: any) => x.sub === ROLE_SUBS.food);
    expect([m.firstName, m.lastName, m.roles[0]]).toEqual(["Fran", "Food", "food"]);
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

  it("lists the club's teams for its admins only", async () => {
    const r = await call("GET", "/teams", CLUB);
    expect(r.body.teams.find((t: any) => t.teamId === T)).toMatchObject({ name: "A5 13 Test", clubId: "a5", yourRoles: [] });
    expect((await call("GET", "/teams", ROLE_SUBS.finance)).body.teams).toEqual([]);
  });
});

describe("tournament duties", () => {
  it("keeps separate ball cart and volleyball families", async () => {
    expect((await call("PUT", `/teams/${T}/events/e-duty`, ROLE_SUBS.coach, { kind: "tournament", title: "Duty test", date: "2027-02-06", cartPid: "p1", ballsPid: "na" })).status).toBe(200);
    const e = (await call("GET", `/teams/${T}`, ROLE_SUBS.parent)).body.events.find((x: any) => x.eid === "e-duty");
    expect([e.cartPid, e.ballsPid]).toEqual(["p1", "na"]);
  });
});

describe("clubs", () => {
  const OWNER = "u-owner", BOSS = "u-boss", TWO = "u-two", RPARENT = "u-rparent";
  const asOwner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
  const asBoss = (m: string, p: string, b?: unknown) => call(m, p, BOSS, b, "boss@rivals.com");
  const RED = { primary: "#7a0019", accent: "#ffcc33" };

  it("only the site owner can add clubs; ids are unique", async () => {
    expect((await asOwner("GET", "/me")).body.platformAdmin).toBe(true);
    expect((await call("GET", "/me", CLUB, undefined, "club@example.com")).body.platformAdmin).toBe(false);
    expect((await call("POST", "/clubs", CLUB, { clubId: "nope", name: "Nope" })).status).toBe(403);
    const r = await asOwner("POST", "/clubs", { clubId: "rivals", name: "Rivals VBC", short: "RVB", colors: RED, adminEmails: ["Boss@Rivals.com"] });
    expect(r.status).toBe(201);
    expect(r.body.colors).toEqual({ primary: "#7A0019", accent: "#FFCC33" });
    expect((await asOwner("POST", "/clubs", { clubId: "rivals", name: "Again" })).status).toBe(409);
    expect((await asOwner("POST", "/clubs", { clubId: "Bad Id", name: "X" })).status).toBe(400);
  });

  it("an invited club admin gets the club when they next open the app", async () => {
    const me = (await asBoss("GET", "/me")).body;
    expect(me.clubAdmin).toBe(true);
    expect(me.clubs).toEqual([expect.objectContaining({ clubId: "rivals", name: "Rivals VBC", admin: true, colors: { primary: "#7A0019", accent: "#FFCC33" } })]);
    expect((await asBoss("GET", "/clubs")).body.clubs.map((c: any) => c.clubId)).toEqual(["rivals"]);
  });

  it("team ids are unique across clubs, including teams made before clubs existed", async () => {
    expect((await asBoss("POST", "/teams", { clubId: "rivals", teamId: T, name: "Copycat" })).status).toBe(409);
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.settings("legacy1"), type: "Settings", teamName: "Old team" } }));
    expect((await asBoss("POST", "/teams", { clubId: "rivals", teamId: "legacy1", name: "Copycat" })).status).toBe(409);
    expect((await call("GET", `/teams/${T}`, ROLE_SUBS.admin)).body.settings.teamName).not.toBe("Copycat");
  });

  it("a club admin runs only their own club's teams", async () => {
    expect((await asBoss("POST", "/teams", { clubId: "rivals", teamId: "r14", name: "Rivals 14", season: "2026-27" })).status).toBe(201);
    const team = (await asBoss("GET", "/teams/r14")).body;
    expect(team.clubId).toBe("rivals");
    expect(team.club).toMatchObject({ name: "Rivals VBC", short: "RVB" });
    expect(team.you.roles).toContain("admin");
    // Not the other club's.
    expect((await asBoss("GET", `/teams/${T}`)).status).toBe(403);
    expect((await asBoss("PUT", `/teams/${T}/settings`, { teamName: "Mine now" })).status).toBe(403);
    expect((await asBoss("POST", "/teams", { clubId: "a5", teamId: "sneaky", name: "Sneaky" })).status).toBe(403);
    expect((await asBoss("POST", "/teams", { clubId: "rivals", teamId: "r15", name: "Copy", copyFrom: T })).status).toBe(403);
    expect((await asBoss("GET", "/clubs/a5")).status).toBe(403);
    expect((await call("GET", "/teams/r14", CLUB)).status).toBe(403);
    expect((await call("PUT", "/clubs/rivals", CLUB, { name: "Ours", colors: RED })).status).toBe(403);
    expect((await asBoss("GET", "/teams")).body.teams.map((t: any) => t.teamId)).toEqual(["r14"]);
    // Default club's team keeps working, with the original club's details.
    const a5 = (await call("GET", `/teams/${T}`, CLUB)).body;
    expect(a5.clubId).toBe("a5");
    expect(a5.club.name).toBe("A5 Volleyball");
  });

  it("the site owner can open any club and team", async () => {
    expect((await asOwner("GET", "/teams/r14")).status).toBe(200);
    expect((await asOwner("GET", `/teams/${T}`)).status).toBe(200);
    expect((await asOwner("GET", "/clubs")).body.clubs.map((c: any) => c.clubId)).toEqual(["a5", "rivals"]);
    expect((await asOwner("GET", "/teams")).body.teams.map((t: any) => t.teamId)).toEqual(expect.arrayContaining([T, "r14"]));
  });

  it("club settings: colors, links and notes, validated", async () => {
    expect((await asBoss("PUT", "/clubs/rivals", { name: "Rivals", colors: { primary: "red", accent: "#FFCC33" } })).status).toBe(400);
    expect((await asBoss("PUT", "/clubs/rivals", { name: "Rivals", colors: RED, links: [{ label: "Bad", url: "javascript:alert(1)" }] })).status).toBe(400);
    const ok = await asBoss("PUT", "/clubs/rivals", { name: "Rivals Volleyball", short: "RV", colors: { primary: "#004225", accent: "#ffffff" },
      links: [{ label: "Registration", url: "https://rivals.example.com/register" }], notes: "Club fees are due in August." });
    expect(ok.status).toBe(200);
    const team = (await asBoss("GET", "/teams/r14")).body;
    expect(team.club).toMatchObject({ name: "Rivals Volleyball", short: "RV", colors: { primary: "#004225", accent: "#FFFFFF" }, notes: "Club fees are due in August." });
    expect(team.club.links).toHaveLength(1);
    expect((await asOwner("GET", "/clubs")).body.clubs.find((c: any) => c.clubId === "rivals").name).toBe("Rivals Volleyball");
  });

  it("the default club starts with the original links", async () => {
    const r = (await call("GET", "/clubs/a5", CLUB)).body;
    expect(r.club.links.length).toBe(4);
    expect(r.teams.map((t: any) => t.teamId)).toContain(T);
  });

  it("club admins add and remove other admins; a club keeps at least one", async () => {
    expect((await asBoss("POST", "/clubs/rivals/admins", { email: "Two@Rivals.com", firstName: "Tess" })).status).toBe(201);
    expect((await asBoss("POST", "/clubs/rivals/admins", { email: "boss@rivals.com" })).status).toBe(409);
    expect((await asBoss("GET", "/clubs/rivals")).body.invites).toEqual([expect.objectContaining({ email: "two@rivals.com", firstName: "Tess" })]);
    expect((await call("GET", "/me", TWO, undefined, "two@rivals.com")).body.clubs[0]).toMatchObject({ clubId: "rivals", admin: true });
    const club = (await asBoss("GET", "/clubs/rivals")).body;
    expect(club.admins.map((a: any) => a.sub).sort()).toEqual([BOSS, TWO]);
    expect(club.invites).toEqual([]);
    expect((await call("DELETE", `/clubs/rivals/admins/${BOSS}`, ROLE_SUBS.admin)).status).toBe(403);
    expect((await call("DELETE", `/clubs/rivals/admins/${TWO}`, BOSS)).status).toBe(204);
    expect((await call("DELETE", `/clubs/rivals/admins/${BOSS}`, BOSS)).status).toBe(409);
    expect((await call("GET", "/me", TWO, undefined, "two@rivals.com")).body.clubAdmin).toBe(false);
    // Withdraw an invite.
    expect((await asBoss("POST", "/clubs/rivals/admins", { email: "three@rivals.com" })).status).toBe(201);
    expect((await asBoss("DELETE", "/clubs/rivals/invites/three%40rivals.com")).status).toBe(204);
    expect((await asBoss("GET", "/clubs/rivals")).body.invites).toEqual([]);
  });

  it("families see their team's club, not admin rights", async () => {
    expect((await asBoss("POST", "/teams/r14/invites", { email: "mom@rivals.com", roles: ["parent"] })).status).toBe(201);
    const me = (await call("GET", "/me", RPARENT, undefined, "mom@rivals.com")).body;
    expect(me.teams).toEqual([expect.objectContaining({ teamId: "r14", clubId: "rivals" })]);
    expect(me.clubs).toEqual([expect.objectContaining({ clubId: "rivals", admin: false })]);
    expect(me.clubAdmin).toBe(false);
    expect((await call("GET", "/clubs/rivals", RPARENT)).status).toBe(403);
    expect((await call("GET", "/teams/r14", RPARENT)).body.you.roles).toEqual(["parent"]);
  });

  it("site owners archive a team: it goes read-only for everyone until it's restored", async () => {
    expect((await asBoss("POST", "/teams/r14/archive")).status).toBe(403);
    expect((await asOwner("POST", "/teams/nope/archive")).status).toBe(404);
    const r = await asOwner("POST", "/teams/r14/archive");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ teamId: "r14", clubId: "rivals", archived: true });
    expect((await asBoss("GET", "/clubs/rivals")).body.teams.find((t: any) => t.teamId === "r14")).toMatchObject({ archived: true, archivedBy: OWNER });
    expect((await call("GET", "/me", RPARENT, undefined, "mom@rivals.com")).body.teams[0]).toMatchObject({ teamId: "r14", archived: true });
    const team = (await call("GET", "/teams/r14", RPARENT)).body;
    expect(team.team.archived).toBe(true);
    // Still readable, but nothing changes: not settings, not players, not a family's own answers.
    expect((await asBoss("PUT", "/teams/r14/settings", { teamName: "Rivals 14" })).status).toBe(409);
    expect((await asOwner("PUT", "/teams/r14/players/x1", { first: "New" })).status).toBe(409);
    expect((await asBoss("POST", "/teams/r14/invites", { email: "late@rivals.com", roles: ["parent"] })).status).toBe(409);
    expect((await asOwner("POST", "/teams/r14/restore")).body.archived).toBe(false);
    expect((await call("GET", "/me", RPARENT, undefined, "mom@rivals.com")).body.teams[0].archived).toBeUndefined();
    expect((await asBoss("GET", "/clubs/rivals")).body.teams.find((t: any) => t.teamId === "r14").archivedBy).toBeUndefined();
    expect((await asBoss("PUT", "/teams/r14/settings", { teamName: "Rivals 14" })).status).toBe(200);
  });

  it("site owners delete a team and everything stored for it, and nothing else", async () => {
    expect((await asBoss("POST", "/teams", { clubId: "rivals", teamId: "r16", name: "Rivals 16" })).status).toBe(201);
    expect((await asBoss("PUT", "/teams/r16/players/p1", { first: "Ana", parents: [{ name: "Mom", cell: "555" }] })).status).toBe(200);
    expect((await asBoss("PUT", "/teams/r16/events/e1", { kind: "tournament", title: "Cup", date: "2027-02-06" })).status).toBe(200);
    expect((await asBoss("POST", "/teams/r16/invites", { email: "mom@rivals.com", roles: ["parent"], pid: "p1" })).status).toBe(201);
    expect((await asBoss("POST", "/teams/r16/invites", { email: "pending@rivals.com", roles: ["parent"] })).status).toBe(201);
    expect((await call("GET", "/me", RPARENT, undefined, "mom@rivals.com")).body.teams.map((t: any) => t.teamId).sort()).toEqual(["r14", "r16"]);

    expect((await asBoss("DELETE", "/teams/r16", { confirm: "r16" })).status).toBe(403);
    expect((await asOwner("DELETE", "/teams/r16")).status).toBe(400);
    expect((await asOwner("DELETE", "/teams/r16", { confirm: "r14" })).status).toBe(400);
    const r = await asOwner("DELETE", "/teams/r16", { confirm: "r16" });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBeGreaterThanOrEqual(8);

    const { QueryCommand, ScanCommand } = await import("@aws-sdk/lib-dynamodb");
    const left = (await ddb.send(new ScanCommand({ TableName: TABLE }))).Items!.filter((i) => `${i.PK}|${i.SK}`.includes("r16"));
    expect(left).toEqual([]);
    expect((await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": "TEAM#r14" } }))).Items!.length).toBeGreaterThan(2);
    expect((await asOwner("GET", "/teams/r16")).status).toBe(404);
    expect((await asOwner("DELETE", "/teams/r16", { confirm: "r16" })).status).toBe(404);
    expect((await asBoss("GET", "/clubs/rivals")).body.teams.map((t: any) => t.teamId)).toEqual(["r14"]);
    const me = (await call("GET", "/me", RPARENT, undefined, "mom@rivals.com")).body;
    expect(me.teams.map((t: any) => t.teamId)).toEqual(["r14"]);
    expect(me.firstName !== undefined).toBe(true);
    // The id is free again.
    expect((await asBoss("POST", "/teams", { clubId: "rivals", teamId: "r16", name: "Rivals 16 again" })).status).toBe(201);
  });
});
