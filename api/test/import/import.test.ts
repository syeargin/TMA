import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-import";
const { event, freshTable } = await import("../api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { parseClubWorkbook, parseTeamWorkbook, toDate, workbookKind } = await import("../../src/lib/import/parse.js");
const { PutCommand, QueryCommand } = await import("@aws-sdk/lib-dynamodb");

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8"));
const TEAM = fixture("team-sample"), BAD = fixture("team-errors"), CLUB = fixture("club-sample");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", BOSS = "u-boss", OTHER = "u-other", COACH = "u-coach";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const boss = (m: string, p: string, b?: unknown) => call(m, p, BOSS, b);
const partition = async (t: string) => (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${t}` } }))).Items!;

beforeAll(async () => {
  await freshTable();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "test", name: "Test" })).status).toBe(201);
  expect((await owner("POST", "/clubs", { clubId: "rivals", name: "Rivals" })).status).toBe(201);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin("test", BOSS), ...keys.clubAdminGsi("test", BOSS), type: "ClubAdmin", email: "boss@example.com" } }));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin("rivals", OTHER), type: "ClubAdmin" } }));
  expect((await boss("POST", "/teams", { clubId: "test", teamId: "test-15", name: "Placeholder" })).status).toBe(201);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("test-15", COACH), ...keys.memberGsi("test-15", COACH), type: "Membership", status: "active", sub: COACH, roles: ["admin", "coach"], email: "dana.fox@example.com" } }));
});

describe("reading workbooks", () => {
  it("tells the two templates apart", () => {
    expect(workbookKind(TEAM)).toBe("team");
    expect(workbookKind(CLUB)).toBe("club");
    expect(workbookKind({ Sheet1: [["a"]] })).toBeNull();
  });

  it("dates: ISO text, US text and Excel serial numbers", () => {
    expect(toDate("2026-12-12")).toBe("2026-12-12");
    expect(toDate("12/5/2026")).toBe("2026-12-05");
    expect(toDate(46368)).toBe("2026-12-12");
    expect(toDate("")).toBe("");
    expect(toDate("next friday")).toBeNull();
    expect(toDate("2026-02-30")).toBeNull();
  });

  it("reads the team workbook, skipping the untouched example rows", () => {
    const p = parseTeamWorkbook(TEAM, "test-15");
    if (p.kind !== "team") throw new Error();
    expect(p.problems.filter((x) => x.level === "error")).toEqual([]);
    const t = p.team;
    expect(t).toMatchObject({ name: "Test 15", season: "2026-27", age: "15U", level: "15 Open", teamCode: "CODE15" });
    expect(t.dues).toEqual({ amountCents: 35000, due: "2026-11-15", label: "Deposit" });
    expect(t.staff.map((s) => [s.email, s.roles])).toEqual([["dana.fox@example.com", ["admin", "coach"]], ["lee.park@example.com", ["coordinator"]], ["kim.ruiz@example.com", ["finance"]]]);
    expect(t.players.map((x) => x.first)).toEqual(["Ivy", "June", "Rae", "Tess"]); // not the example "Ava"
    expect(t.players[0].parents).toEqual([
      { name: "Kim Ruiz", email: "kim.ruiz@example.com", cell: "555-0110", invite: true },
      { name: "Sam Ruiz", email: "sam.ruiz@example.com", cell: undefined, invite: false }
    ]);
    expect(t.practices).toEqual([
      expect.objectContaining({ label: "Tuesday practice", dow: 2, start: "6:30 PM", end: "8:30 PM", from: "2026-10-06" }),
      expect.objectContaining({ label: "Saturday practice", dow: 6, until: "2027-05-29" })
    ]);
    expect(t.events.map((e) => e.title)).toEqual(["Peach Classic", "Team dinner", "Fund deposit due"]);
    expect(t.events[0]).toMatchObject({ kind: "tournament", cartJersey: "8", ballsJersey: "na", travel: false, endDate: "2026-12-06" });
    expect(t.events[1].repeat).toEqual({ every: 1, days: [3], until: "2026-11-04", skipTournaments: true });
    expect(t.checklist).toEqual(["Water bottle", "Snacks"]);
    expect(t.uniformItems).toEqual(["Home jersey"]);
  });

  it("lists every mistake by tab and row", () => {
    const p = parseTeamWorkbook(BAD, "x");
    const msgs = p.problems.map((x) => `${x.level} ${x.sheet} ${x.row ?? ""}: ${x.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^error Roster 3: Parent 1 email isn't an email/),
      expect.stringMatching(/^error Roster 4: .*Player last name is required|^error Roster 4: Parent 1 name is required/),
      expect.stringMatching(/^error Roster 5: Jersey 3 is also on row 3/),
      expect.stringMatching(/^error Schedule 3: Start date isn't a date/),
      expect.stringMatching(/^error Schedule 3: Tournaments can't repeat/),
      expect.stringMatching(/^error Schedule 4: Type should be Tournament, Event or Deadline/)
    ]));
  });

  it("reads the club workbook and spreads groups over teams", () => {
    const p = parseClubWorkbook(CLUB, "test");
    if (p.kind !== "club") throw new Error();
    expect(p.problems.filter((x) => x.level === "error")).toEqual([]);
    expect(p.club).toMatchObject({ name: "Test Club", short: "Test", colors: { primary: "#14532D", accent: "#9AD3A5" } });
    expect(p.club.links).toHaveLength(2);
    expect(p.club.defaults.handbook).toEqual([{ t: "Playing time", b: "Playing time is earned at practice." }]);
    const by = Object.fromEntries(p.teams.map((t) => [t.teamId, t]));
    expect(Object.keys(by)).toEqual(["test-15a", "test-15b", "test-16"]);
    expect(by["test-15a"].practices!.map((x) => x.label)).toEqual(["Monday practice"]);
    expect(by["test-15b"].practices!.map((x) => x.label)).toEqual(["Monday practice"]);
    expect(by["test-16"].practices!.map((x) => x.label)).toEqual(["Thursday practice"]);
    expect(by["test-15a"].events.map((e) => e.title)).toEqual(["National Qualifier", "Club fees due"]);
    expect(by["test-15b"].events.map((e) => e.title)).toEqual(["Club fees due"]);
    expect(by["test-16"].copyFrom).toBe("test-15a");
    expect(parseClubWorkbook(CLUB, "elsewhere").problems[0].message).toMatch(/Club ID is "test"/);
  });
});

describe("team import", () => {
  it("only club admins and site owners import; families and team admins can't", async () => {
    expect((await call("POST", "/teams/test-15/import", COACH, { sheets: TEAM })).status).toBe(403);
    expect((await call("POST", "/teams/test-15/import", OTHER, { sheets: TEAM })).status).toBe(403);
    expect((await boss("POST", "/teams/test-15/import", { sheets: CLUB })).status).toBe(400);
  });

  it("previews without saving, then saves", async () => {
    const before = (await partition("test-15")).length;
    const prev = await boss("POST", "/teams/test-15/import", { sheets: TEAM });
    expect(prev.status).toBe(200);
    expect(prev.body.teams[0]).toMatchObject({
      teamId: "test-15", status: "update", name: "Test 15",
      players: { add: 4, update: 0, kept: 0 }, events: { add: 3, update: 0 }, practices: 2,
      // Dana is already on the team; Kim is staff and a parent (one invite, both roles); Bo has two players.
      invites: { staff: 2, parents: 2, alreadyOnTeam: 1 }
    });
    expect(prev.body.problems.some((p: any) => /bo.cole@example.com is a parent of more than one player/.test(p.message))).toBe(true);
    expect((await partition("test-15")).length).toBe(before);

    const done = await boss("POST", "/teams/test-15/import", { sheets: TEAM, apply: true });
    expect(done.status).toBe(200);
    const team = (await boss("GET", "/teams/test-15")).body;
    expect(team.settings).toMatchObject({ teamName: "Test 15", teamCode: "CODE15", dues: { amountCents: 35000, due: "2026-11-15" }, checklist: ["Water bottle", "Snacks"] });
    expect(team.settings.coaches).toEqual([{ name: "Dana Fox", phone: "555-0201" }]);
    expect(team.players.map((p: any) => p.first).sort()).toEqual(["Ivy", "June", "Rae", "Tess"]);
    expect(team.players.find((p: any) => p.first === "Ivy").parents).toHaveLength(2);
    const peach = team.events.find((e: any) => e.title === "Peach Classic");
    expect(peach.cartPid).toBe(team.players.find((p: any) => p.jersey === "8").pid);
    expect(peach.ballsPid).toBe("na");
    expect(team.events.find((e: any) => e.title === "Team dinner").repeat.days).toEqual([3]);
    const invites = (await boss("GET", "/teams/test-15/invites")).body.invites;
    const kim = invites.find((i: any) => i.email === "kim.ruiz@example.com");
    expect(kim.roles.sort()).toEqual(["finance", "parent"]);
    expect(kim.pid).toBe(team.players.find((p: any) => p.first === "Ivy").pid);
    expect(invites.map((i: any) => i.email)).not.toContain("sam.ruiz@example.com");
    expect((await boss("GET", "/clubs/test")).body.teams.find((t: any) => t.teamId === "test-15")).toMatchObject({ name: "Test 15", level: "15 Open" });
  });

  it("uploading again updates instead of duplicating, and keeps what families entered", async () => {
    const team = (await boss("GET", "/teams/test-15")).body;
    const ivy = team.players.find((p: any) => p.first === "Ivy").pid;
    const peach = team.events.find((e: any) => e.title === "Peach Classic");
    // A family answers; a coach adds game-day details and cancels a practice date.
    expect((await boss("PUT", `/teams/test-15/events/${peach.eid}`, { ...peach, eid: undefined, parking: "Lot C" })).status).toBe(200);
    const tue = team.settings.practices.find((p: any) => p.label === "Tuesday practice").id;
    expect((await boss("PUT", `/teams/test-15/practices/cancelled/pr-${tue}-2026-10-13`)).status).toBe(200);
    expect((await boss("PUT", `/teams/test-15/players/extra`, { first: "Walk", last: "On" })).status).toBe(200);

    const again = await boss("POST", "/teams/test-15/import", { sheets: TEAM, apply: true });
    expect(again.body.teams[0]).toMatchObject({ players: { add: 0, update: 4, kept: 1 }, events: { add: 0, update: 3 } });
    const after = (await boss("GET", "/teams/test-15")).body;
    expect(after.players).toHaveLength(5);
    expect(after.players.find((p: any) => p.first === "Ivy").pid).toBe(ivy);
    expect(after.events).toHaveLength(3);
    expect(after.events.find((e: any) => e.title === "Peach Classic")).toMatchObject({ eid: peach.eid, parking: "Lot C" });
    expect(after.settings.practices.find((p: any) => p.label === "Tuesday practice").id).toBe(tue);
    expect(after.settings.cancelled).toContain(`pr-${tue}-2026-10-13`);
  });

  it("refuses to save a workbook with errors", async () => {
    const r = await boss("POST", "/teams/test-15/import", { sheets: BAD, apply: true });
    expect(r.status).toBe(422);
    const prev = await boss("POST", "/teams/test-15/import", { sheets: BAD });
    expect(prev.status).toBe(200);
    expect(prev.body.problems.filter((p: any) => p.level === "error").length).toBeGreaterThan(3);
  });

  it("archived teams can't be imported into", async () => {
    expect((await owner("POST", "/teams/test-15/archive")).status).toBe(200);
    expect((await boss("POST", "/teams/test-15/import", { sheets: TEAM })).status).toBe(409);
    expect((await owner("POST", "/teams/test-15/restore")).status).toBe(200);
  });
});

describe("club import", () => {
  it("previews the whole club, in an order that copies from teams before it", async () => {
    expect((await call("POST", "/clubs/test/import", OTHER, { sheets: CLUB })).status).toBe(403);
    const r = await boss("POST", "/clubs/test/import", { sheets: CLUB });
    expect(r.status).toBe(200);
    expect(r.body.problems.filter((p: any) => p.level === "error")).toEqual([]);
    expect(r.body.order).toEqual(["test-15a", "test-15b", "test-16"]);
    expect(r.body.club).toMatchObject({ admins: { invite: 1, already: 0 } });
    expect(r.body.club.changes).toEqual(expect.arrayContaining(["Name: Test Club", "Colors"]));
    expect(r.body.teams.map((t: any) => [t.teamId, t.status, t.players.add, t.events.add])).toEqual([
      ["test-15a", "new", 2, 2], ["test-15b", "new", 1, 1], ["test-16", "new", 1, 2]
    ]);
  });

  it("saves the club, then each team; new teams get the defaults or the team they copy", async () => {
    expect((await boss("POST", "/clubs/test/import", { sheets: CLUB, apply: "club" })).status).toBe(200);
    for (const t of ["test-15a", "test-15b", "test-16"]) {
      const r = await boss("POST", "/clubs/test/import", { sheets: CLUB, apply: t });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const club = (await boss("GET", "/clubs/test")).body;
    expect(club.club).toMatchObject({ name: "Test Club", colors: { primary: "#14532D", accent: "#9AD3A5" }, notes: "Club dues are due in August." });
    expect(club.club.links.map((l: any) => l.label)).toEqual(["Club calendar", "Uniform store"]);
    expect(club.invites.map((i: any) => i.email)).toEqual(["pat.lane@example.com"]);
    expect(club.teams.find((t: any) => t.teamId === "test-15b")).toMatchObject({ program: "Regional", age: "15U" });

    const a = (await boss("GET", "/teams/test-15a")).body;
    expect(a.handbook.sections).toEqual([{ t: "Playing time", b: "Playing time is earned at practice." }]);
    expect(a.settings.checklist).toEqual(["Knee pads"]);
    expect(a.events.find((e: any) => e.title === "National Qualifier")).toMatchObject({ travel: true, hotelCode: "QUAL27", endDate: "2027-02-15" });
    const t16 = (await boss("GET", "/teams/test-16")).body;
    // Copied test-15a's practices, then the workbook's own practice for 16U replaced them.
    expect(t16.settings.practices.map((p: any) => p.label)).toEqual(["Thursday practice"]);
    expect(t16.handbook.sections).toEqual(a.handbook.sections);
  });

  it("a team id another club uses is an error, and a team workbook can create a team here", async () => {
    expect((await call("POST", "/teams", OTHER, { clubId: "rivals", teamId: "r-15", name: "Rivals 15" })).status).toBe(201);
    const clash = await boss("POST", "/clubs/test/import", { sheets: TEAM, teamId: "r-15" });
    expect(clash.body.problems[0].message).toMatch(/already used by another club/);
    expect((await boss("POST", "/clubs/test/import", { sheets: TEAM, teamId: "r-15", apply: "r-15" })).status).toBe(422);
    expect((await boss("POST", "/clubs/test/import", { sheets: TEAM })).status).toBe(400);
    const made = await boss("POST", "/clubs/test/import", { sheets: TEAM, teamId: "test-15c", apply: "test-15c" });
    expect(made.status).toBe(200);
    expect(made.body.teams[0]).toMatchObject({ teamId: "test-15c", status: "new" });
    expect((await boss("GET", "/teams/test-15c")).body.clubId).toBe("test");
  });
});
