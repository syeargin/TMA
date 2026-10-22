import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-export";
const { event, freshTable } = await import("../api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { toSheet } = await import("../../src/lib/export/export.js");
const { PutCommand, QueryCommand } = await import("@aws-sdk/lib-dynamodb");

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8"));
const TEAM = fixture("team-sample"), CLUB = fixture("club-sample");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", BOSS = "u-boss";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const boss = (m: string, p: string, b?: unknown) => call(m, p, BOSS, b);

/** A team's saved records, without the "when and who" stamps an import refreshes. */
async function snapshot(teamId: string) {
  const items = (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${teamId}` } }))).Items!;
  const strip = (v: any): any => Array.isArray(v) ? v.map(strip) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !["updatedAt", "updatedBy", "at", "createdAt", "createdBy"].includes(k)).map(([k, x]) => [k, strip(x)])) : v;
  return items.map(strip).sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
}
const asSheets = (sheets: Record<string, any[]>) => Object.fromEntries(Object.entries(sheets).map(([tab, rows]) => [tab, toSheet(rows)]));

beforeAll(async () => {
  await freshTable();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "test", name: "Test" })).status).toBe(201);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin("test", BOSS), ...keys.clubAdminGsi("test", BOSS), type: "ClubAdmin", email: "boss@example.com", firstName: "Bo", lastName: "Boss" } }));
});

describe("team export", () => {
  it("exports the team in the Team setup workbook's shape", async () => {
    expect((await boss("POST", "/clubs/test/import", { sheets: TEAM, teamId: "rt-15", apply: "rt-15" })).status).toBe(200);
    expect((await boss("PUT", "/teams/rt-15/handbook", { sections: [{ t: "Attendance", b: "Tell the coach." }] })).status).toBe(200);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await boss("GET", "/teams/rt-15/export");
    expect(r.status).toBe(200);
    expect(JSON.parse(log.mock.calls.map((c) => c[0]).find((l) => String(l).includes('"export"')))).toMatchObject({ msg: "export", kind: "team", teamId: "rt-15", by: BOSS });
    log.mockRestore();
    const sh = r.body.sheets;
    expect(Object.keys(sh)).toEqual(["Team", "Staff", "Roster", "Practices", "Schedule", "Lists"]);
    expect(sh.Team[0]).toMatchObject({ "Team name": "Test 15", "Season": "2026-27", "Dues amount": 350, "Dues due date": "2026-11-15" });
    expect(sh.Staff.map((s: any) => s.Email)).toEqual(expect.arrayContaining(["dana.fox@example.com", "lee.park@example.com", "kim.ruiz@example.com"]));
    expect(sh.Staff.find((s: any) => s.Email === "dana.fox@example.com")).toMatchObject({ "Team admin": "Y", "Coach": "Y", "Mobile": "555-0201", "Show phone to families": "Y" });
    const ivy = sh.Roster.find((p: any) => p["Player first name"] === "Ivy");
    expect(ivy).toMatchObject({ "Parent 1 email": "kim.ruiz@example.com", "Parent 1 invite": "Y", "Parent 2 email": "sam.ruiz@example.com", "Parent 2 invite": "N" });
    expect(sh.Practices.map((p: any) => p.Name)).toEqual(expect.arrayContaining(["Tuesday practice", "Saturday practice"]));
    expect(sh.Schedule.find((e: any) => e.Title === "Peach Classic")).toMatchObject({ "Type": "Tournament", "Ball cart family": "8", "Volleyballs family": "Not needed" });
    expect(sh.Lists).toEqual(expect.arrayContaining([{ "List": "Handbook section", "Title": "Attendance", "Item": "Tell the coach." }]));
  });

  it("uploads again without changing anything", async () => {
    const before = await snapshot("rt-15");
    const sheets = asSheets((await boss("GET", "/teams/rt-15/export")).body.sheets);
    const prev = await boss("POST", "/clubs/test/import", { sheets, teamId: "rt-15" });
    expect(prev.status).toBe(200);
    expect(prev.body.problems.filter((p: any) => p.level === "error")).toEqual([]);
    expect(prev.body.teams[0]).toMatchObject({ status: "update", players: { add: 0, kept: 0 }, events: { add: 0 } });
    expect((await boss("POST", "/clubs/test/import", { sheets, teamId: "rt-15", apply: "rt-15" })).status).toBe(200);
    expect(await snapshot("rt-15")).toEqual(before);
  });

  it("is for the team's admins only", async () => {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("rt-15", "u-parent"), ...keys.memberGsi("rt-15", "u-parent"), type: "Membership", status: "active", sub: "u-parent", roles: ["parent", "coach", "coordinator"], email: "p@example.com" } }));
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("rt-15", "u-tadmin"), ...keys.memberGsi("rt-15", "u-tadmin"), type: "Membership", status: "active", sub: "u-tadmin", roles: ["admin"], email: "t@example.com" } }));
    expect((await call("GET", "/teams/rt-15/export", "u-parent")).status).toBe(403);
    expect((await call("GET", "/teams/rt-15/export", "u-stranger")).status).toBe(403);
    expect((await call("GET", "/teams/rt-15/export", "u-tadmin")).status).toBe(200);
    expect((await call("GET", "/clubs/test/export", "u-tadmin")).status).toBe(403);
  });
});

describe("club export", () => {
  it("exports the club and its teams, and uploads again without changing anything", async () => {
    const steps = ["club", "test-15a", "test-15b", "test-16"];
    for (const apply of steps) expect((await owner("POST", "/clubs/test/import", { sheets: CLUB, apply })).status).toBe(200);
    expect((await boss("PUT", "/teams/test-16/handbook", { sections: [{ t: "Own rule", b: "Only for 16s." }] })).status).toBe(200);
    const before = Object.fromEntries(await Promise.all(steps.slice(1).concat("rt-15").map(async (t) => [t, await snapshot(t)])));

    const r = await boss("GET", "/clubs/test/export");
    expect(r.status).toBe(200);
    const sh = r.body.sheets;
    expect(Object.keys(sh)).toEqual(["Club", "Club links", "Club admins", "Teams", "Staff", "Rosters", "Practice patterns", "Shared schedule", "Team lists", "Defaults"]);
    expect(sh.Club[0]).toMatchObject({ "Club name": "Test Club", "Club ID": "test", "Main color": "#14532D" });
    expect(sh.Teams.map((t: any) => t["Team ID"]).sort()).toEqual(["rt-15", "test-15a", "test-15b", "test-16"]);
    expect(sh["Club admins"].map((a: any) => a.Email)).toContain("boss@example.com");
    expect(sh["Team lists"]).toEqual(expect.arrayContaining([{ "Team ID": "test-16", "List": "Handbook section", "Title": "Own rule", "Text or item": "Only for 16s." }]));

    const sheets = asSheets(sh);
    const prev = await boss("POST", "/clubs/test/import", { sheets });
    expect(prev.status).toBe(200);
    expect(prev.body.problems.filter((p: any) => p.level === "error")).toEqual([]);
    for (const t of prev.body.teams) expect(t).toMatchObject({ status: "update", players: { add: 0 }, events: { add: 0 } });
    for (const apply of ["club", ...prev.body.order]) expect((await boss("POST", "/clubs/test/import", { sheets, apply })).status).toBe(200);
    for (const [t, snap] of Object.entries(before)) expect(await snapshot(t)).toEqual(snap);
  });

  it("leaves archived teams out", async () => {
    expect((await owner("POST", "/teams/test-15b/archive")).status).toBe(200);
    const r = await boss("GET", "/clubs/test/export");
    expect(r.body.sheets.Teams.map((t: any) => t["Team ID"])).not.toContain("test-15b");
    expect(r.body.archived).toEqual(["test-15b"]);
  });
});
