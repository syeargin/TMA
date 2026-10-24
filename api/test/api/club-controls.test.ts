import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-club-controls";
process.env.MAIL_TRANSPORT = "memory";
process.env.SMS_ORIGINATION = "+18885550100";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { runPlanner } = await import("../../src/lib/comms/planner.js");
const { purgeDue } = await import("../../src/lib/retention.js");
const { PutCommand, GetCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", BOSS = "u-boss", PARENT = "u-par";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const boss = (m: string, p: string, b?: unknown) => call(m, p, BOSS, b, "boss@example.com");
const parent = (m: string, p: string, b?: unknown) => call(m, p, PARENT, b, "par@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const controls = async (c: string) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.clubControls(c) }))).Item;
const newTeam = (teamId: string) => boss("POST", "/teams", { clubId: "cc", teamId, name: teamId.toUpperCase() });
const setControls = (b: Record<string, unknown>) => owner("PUT", "/admin/clubs/cc", b);
const CLUB = JSON.parse(readFileSync(new URL("../import/club-sample.json", import.meta.url), "utf8"));

beforeAll(async () => {
  await freshTable();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "cc", name: "Control Club" })).status).toBe(201);
  expect((await owner("POST", "/clubs", { clubId: "test", name: "Import Club" })).status).toBe(201);
  for (const c of ["cc", "test"]) await put({ ...keys.clubAdmin(c, BOSS), ...keys.clubAdminGsi(c, BOSS), type: "ClubAdmin", email: "boss@example.com" });
  expect((await newTeam("cc-1")).status).toBe(201);
  await put({ ...keys.member("cc-1", PARENT), ...keys.memberGsi("cc-1", PARENT), type: "Membership", status: "active", sub: PARENT, roles: ["parent"], pid: "p1", email: "par@example.com" });
  await put({ ...keys.player("cc-1", "p1"), type: "Player", first: "Ava", last: "Stone" });
  expect((await parent("GET", "/me")).status).toBe(200);
});

describe("existing clubs", () => {
  it("are active, with every feature and no team limit, until a site owner changes them", async () => {
    const c = (await boss("GET", "/clubs/cc")).body.controls;
    expect(c).toEqual({ status: "active", features: {}, teamLimit: null, activeTeams: 1 });
    const team = (await parent("GET", "/teams/cc-1")).body;
    expect(team.clubControls).toEqual({ status: "active", features: {}, teamLimit: null });
    expect((await parent("GET", "/me/sms")).body.allowed).toBe(true);
  });
});

describe("the site admin dashboard", () => {
  it("is for site owners only", async () => {
    expect((await boss("GET", "/admin/clubs")).status).toBe(403);
    expect((await boss("PUT", "/admin/clubs/cc", { teamLimit: 9 })).status).toBe(403);
    const r = await owner("GET", "/admin/clubs");
    expect(r.body.clubs.find((c: any) => c.clubId === "cc")).toMatchObject({ name: "Control Club", status: "active", teamLimit: null, activeTeams: 1, archivedTeams: 0, admins: 1, teams: [{ teamId: "cc-1", name: "CC-1" }] });
    expect(r.body.features.map((f: any) => f.id)).toEqual(["fund", "meals", "travel", "refjobs", "uniforms", "tasks", "handbook", "email", "texts"]);
  });

  it("records every change, with who and why", async () => {
    expect((await setControls({ teamLimit: 2 })).body).toMatchObject({ changed: true, teamLimit: 2, activeTeams: 1 });
    expect((await setControls({ teamLimit: 2 })).body.changed).toBe(false);
    const h = (await owner("GET", "/admin/clubs/cc/history")).body.history;
    expect(h[0]).toMatchObject({ changes: ["Team limit set to 2"], by: expect.any(String) });
  });
});

describe("team limit", () => {
  it("counts only teams that aren't archived, and holds under two creates at once", async () => {
    expect((await newTeam("cc-2")).status).toBe(201);
    const full = await newTeam("cc-3");
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ error: "team_limit", message: expect.stringMatching(/limit of 2 active teams/) });
    // Archiving gives a place back; restoring it while full is refused.
    expect((await owner("POST", "/teams/cc-2/archive")).status).toBe(200);
    expect((await controls("cc"))!.activeTeams).toBe(1);
    const both = await Promise.all([newTeam("cc-4"), newTeam("cc-5")]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await controls("cc"))!.activeTeams).toBe(2);
    expect((await owner("POST", "/teams/cc-2/restore")).body).toMatchObject({ error: "team_limit" });
    // Deleting (which archives at once) gives a place back too.
    const made = both[0].status === 201 ? "cc-4" : "cc-5";
    expect((await owner("DELETE", `/teams/${made}`, { confirm: made })).status).toBe(200);
    expect((await owner("POST", "/teams/cc-2/restore")).status).toBe(200);
    expect((await boss("GET", "/clubs/cc")).body.controls).toMatchObject({ teamLimit: 2, activeTeams: 2 });
  });

  it("is fixed by the daily recount if the stored number drifts", async () => {
    await ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.clubControls("cc"), UpdateExpression: "SET activeTeams = :n", ExpressionAttributeValues: { ":n": 7 } }));
    await purgeDue();
    expect((await controls("cc"))!.activeTeams).toBe(2);
  });

  it("applies to new teams in a club workbook", async () => {
    await owner("PUT", "/admin/clubs/test", { teamLimit: 2 });
    const r = await boss("POST", "/clubs/test/import", { sheets: CLUB });
    expect(r.body.problems.filter((p: any) => p.level === "error").map((p: any) => p.message)).toEqual([
      "This file adds 3 new teams, but your club has room for 2 more (its limit is 2 active teams). Archive a team, or ask a site owner to raise the limit."
    ]);
  });
});

describe("club features", () => {
  it("switch a feature off for every team, whatever the team chose", async () => {
    expect((await setControls({ features: { fund: false, texts: false } })).body.features).toEqual({ fund: false, texts: false });
    const team = (await parent("GET", "/teams/cc-1")).body;
    expect(team.settings.features.fund).toBe(false);
    expect(team.settings.teamFeatures.fund).toBeUndefined();
    const pay = await parent("POST", "/teams/cc-1/payments", { kind: "in", pid: "p1", amountCents: 1000, date: "2026-10-24", desc: "Dues" });
    expect(pay.body).toMatchObject({ error: "feature_off", message: "Team fund isn't included for your club. A site owner can turn it on." });
    expect((await owner("PUT", "/teams/cc-1/features", { features: { fund: true } })).body.message).toMatch(/isn't included for your club/);
    // Text alerts: nobody in the club can opt in (site owners still can, to try it).
    expect((await parent("GET", "/me/sms")).body.allowed).toBe(false);
    expect((await parent("PUT", "/me/sms", { phone: "6145550123", agree: true, consentVersion: "2026-10-24" })).status).toBe(403);
    expect((await setControls({ features: { fund: true, texts: true } })).body.features).toEqual({});
    expect((await parent("GET", "/teams/cc-1")).body.settings.features.fund).toBeUndefined();
  });

  it("Team emails off: the Communications page says so and the planner sends nothing", async () => {
    expect((await owner("PUT", "/teams/cc-1/comms", { messages: { weekly: { on: true } } })).status).toBe(200);
    expect((await setControls({ features: { email: false } })).status).toBe(200);
    expect((await owner("GET", "/teams/cc-1/comms")).body.clubEmail).toBe(false);
    expect((await runPlanner(new Date("2026-11-01T23:05:00Z"))).sends).toEqual([]);
    expect((await setControls({ features: { email: true } })).status).toBe(200);
    expect((await runPlanner(new Date("2026-11-01T23:05:00Z"))).sends.map((s) => s.key)).toEqual(["weekly:2026-11-01"]);
  });
});

describe("inactive clubs", () => {
  it("need a reason", async () => {
    expect((await setControls({ status: "inactive" })).status).toBe(400);
  });

  it("are read-only for everyone, and send no team email, until made active again", async () => {
    expect((await setControls({ status: "inactive", reason: "Season over; club not renewed" })).body).toMatchObject({ status: "inactive", statusReason: "Season over; club not renewed" });
    // Reading still works; changing doesn't, for families, club admins or site owners.
    expect((await parent("GET", "/teams/cc-1")).body.clubControls.status).toBe("inactive");
    expect((await parent("GET", "/me")).body.teams.find((t: any) => t.teamId === "cc-1")).toMatchObject({ clubInactive: true });
    for (const who of [boss, owner]) {
      const r = await who("PUT", "/teams/cc-1/announcements/a1", { text: "Hello" });
      expect(r.body).toMatchObject({ error: "club_inactive", message: "This club is inactive, so its teams are read-only. A site owner can reactivate it." });
    }
    expect((await boss("PUT", "/clubs/cc", { name: "Renamed", colors: { primary: "#15294D", accent: "#C8323E" } })).body.error).toBe("club_inactive");
    expect((await newTeam("cc-9")).body.message).toMatch(/club is inactive/);
    expect((await runPlanner(new Date("2026-11-08T23:05:00Z"))).sends).toEqual([]);
    // The club admin's page shows it.
    expect((await boss("GET", "/clubs/cc")).body.controls.status).toBe("inactive");

    expect((await setControls({ status: "active" })).status).toBe(200);
    expect((await boss("PUT", "/teams/cc-1/announcements/a1", { text: "Hello" })).status).toBe(200);
    const h = (await owner("GET", "/admin/clubs/cc/history")).body.history;
    expect(h.slice(0, 2).map((x: any) => x.changes[0])).toEqual(["Made the club active again", "Made the club inactive"]);
    expect(h[1].reason).toBe("Season over; club not renewed");
  });
});
