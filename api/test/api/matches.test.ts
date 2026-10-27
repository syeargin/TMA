import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-matches";
process.env.MAIL_TRANSPORT = "memory";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { describeChange } = await import("../../src/realtime/changes.js");
const M = await import("../../src/shared/matches.js");
type MatchDoc = import("../../src/shared/matches.js").MatchDoc;
type Result = import("../../src/shared/matches.js").Result;
const { PutCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COACH = "u-coach", MIA = "u-mia", DAN = "u-dan", FOOD = "u-food";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const T = "m13";
const member = (sub: string, roles: string[], pid = "") => put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles, pid });
const save = (who: string, mid: string, b: Record<string, unknown>, eid = "fc") => call("PUT", `/teams/${T}/events/${eid}/matches/${mid}`, who, b);
const bundle = async (who: string) => (await call("GET", `/teams/${T}`, who)).body;

beforeAll(async () => {
  await freshTable();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "mc", name: "Match Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "mc", teamId: T, name: "Match 13" })).status).toBe(201);
  await put({ ...keys.event(T, "fc"), type: "Event", eid: "fc", kind: "tournament", title: "Fall Classic", date: "2026-11-14", endDate: "2026-11-15" });
  await put({ ...keys.event(T, "hb"), type: "Event", eid: "hb", kind: "tournament", title: "Halloween Bash", date: "2026-10-31" });
  await put({ ...keys.event(T, "pr"), type: "Event", eid: "pr", kind: "practice", title: "Practice", date: "2026-11-10" });
  await put({ ...keys.player(T, "p1"), type: "Player", first: "Ava" });
  await put({ ...keys.player(T, "p2"), type: "Player", first: "Bea" });
  await member(COACH, ["coach"]); await member(MIA, ["parent"], "p1"); await member(DAN, ["parent"], "p2"); await member(FOOD, ["food"]);
});

describe("match rules (shared)", () => {
  it("works out the result from the sets, leaving a 2-set split to staff", () => {
    expect(M.suggestedResult({ format: 3, sets: [{ us: 25, them: 21 }, { us: 23, them: 25 }, { us: 15, them: 11 }] })).toBe("W");
    expect(M.suggestedResult({ format: 3, sets: [{ us: 19, them: 25 }, { us: 22, them: 25 }] })).toBe("L");
    expect(M.suggestedResult({ format: 3, sets: [{ us: 25, them: 19 }] })).toBe("");
    expect(M.suggestedResult({ format: 2, sets: [{ us: 25, them: 19 }, { us: 20, them: 25 }] })).toBe("");
    expect(M.suggestedResult({ format: 2, sets: [{ us: 25, them: 19 }, { us: 25, them: 23 }] })).toBe("W");
    expect(M.suggestedResult({ format: 5, sets: [{ us: 25, them: 19 }, { us: 25, them: 23 }, { us: 20, them: 25 }, { us: 25, them: 22 }] })).toBe("W");
  });
  it("finds sets that can't happen", () => {
    expect(M.matchProblem({ format: 3, sets: [{ us: 25, them: 25 }], result: "" })).toMatch(/tied/);
    expect(M.matchProblem({ format: 3, sets: [{ us: 25, them: 20 }, { us: 25, them: 20 }, { us: 15, them: 10 }], result: "W" })).toMatch(/already won/);
    expect(M.matchProblem({ format: 2, sets: [{ us: 25, them: 20 }, { us: 25, them: 20 }, { us: 15, them: 10 }], result: "W" })).toMatch(/at most 2/);
    expect(M.matchProblem({ format: 3, sets: [{ us: 25, them: 20 }, { us: 25, them: 20 }], result: "L" })).toMatch(/sets say win/);
    expect(M.matchProblem({ format: 2, sets: [{ us: 25, them: 20 }, { us: 20, them: 25 }], result: "L" })).toBe("");
  });
  it("lists a tournament's days, 3 rows each unless changed, and adds them up", () => {
    expect(M.tournamentDays("2026-11-14", "2026-11-15")).toEqual(["2026-11-14", "2026-11-15"]);
    expect(M.tournamentDays("2026-10-31")).toEqual(["2026-10-31"]);
    const doc = {
      slots: { "2026-11-14": 4 },
      matches: {
        "2026-11-14-1": { date: "2026-11-14", n: 1, format: 3, sets: [{ us: 25, them: 21 }, { us: 23, them: 25 }, { us: 15, them: 11 }], result: "W" },
        "2026-11-14-2": { date: "2026-11-14", n: 2, format: 3, sets: [{ us: 19, them: 25 }, { us: 22, them: 25 }], result: "L" },
        "2026-11-15-5": { date: "2026-11-15", n: 5, format: 3, sets: [], result: "" }
      }
    } as MatchDoc;
    const v = M.tournamentView(doc, ["2026-11-14", "2026-11-15"]);
    expect(v.days.map((d) => d.rows.length)).toEqual([4, 5]);
    expect(v.days[0].totals).toMatchObject({ played: 2, won: 1, lost: 1, setsWon: 2, setsLost: 3, pointsFor: 104, pointsAgainst: 107, toPlay: 2 });
    expect(v.totals).toMatchObject({ played: 2, toPlay: 7 });
    expect(M.pointDiff(v.totals)).toBe("−3");
  });
  it("puts the season together: last 10, each set's record and opponents met twice", () => {
    const m = (date: string, n: number, opponent: string, result: Result, sets: [number, number][]) => ({ date, n, opponent, result, format: 3 as const, sets: sets.map(([us, them]) => ({ us, them })) });
    const docs = {
      a: { matches: { x: m("2026-09-06", 1, "Lakeside 13 Gold", "W", [[25, 20], [25, 18]]), y: m("2026-09-06", 2, "River City", "L", [[20, 25], [25, 23], [10, 15]]) } },
      b: { matches: { z: m("2026-10-31", 1, " lakeside 13  gold", "W", [[25, 22], [21, 25], [15, 9]]), w: { date: "2026-10-31", n: 2, format: 3 as const, sets: [], result: "" as const } } }
    };
    const all = M.seasonMatches([{ eid: "a", title: "Labor Day" }, { eid: "b", title: "Halloween" }], docs);
    expect(all.map((x) => x.opponent?.trim())).toEqual(["Lakeside 13 Gold", "River City", "lakeside 13  gold"]);
    const s = M.seasonStats(all);
    expect(M.record(s.totals)).toBe("2–1");
    expect(s.last).toEqual(["W", "L", "W"]);
    expect(s.bySet).toEqual([{ set: 1, won: 2, lost: 1 }, { set: 2, won: 2, lost: 1 }, { set: 3, won: 1, lost: 1 }]);
    expect(s.opponents).toEqual([{ name: "Lakeside 13 Gold", won: 2, lost: 0, setsWon: 4, setsLost: 1 }]);
    expect(s.latest?.title).toBe("Halloween");
  });
});

describe("entering scores", () => {
  it("lets staff save a match, filling in the result and dropping empty trailing sets", async () => {
    const r = await save(COACH, "2026-11-14-1", { time: "8:00 AM", court: "6", opponent: "Lakeside 13 Gold", format: 3, sets: [{ us: 25, them: 18 }, { us: 25, them: 20 }, { us: 0, them: 0 }] });
    expect(r.status).toBe(200);
    expect(r.body.match).toMatchObject({ date: "2026-11-14", n: 1, result: "W", sets: [{ us: 25, them: 18 }, { us: 25, them: 20 }] });
    const b = await bundle(MIA);
    expect(b.matches.fc.matches["2026-11-14-1"]).toMatchObject({ opponent: "Lakeside 13 Gold", result: "W" });
  });

  it("refuses scores that don't add up, days outside the tournament and events that aren't tournaments", async () => {
    expect((await save(COACH, "2026-11-14-2", { format: 3, sets: [{ us: 25, them: 20 }, { us: 25, them: 20 }], result: "L" })).body.message).toMatch(/sets say win/);
    expect((await save(COACH, "2026-11-14-2", { format: 2, sets: [{ us: 25, them: 20 }, { us: 20, them: 25 }] })).body.message).toMatch(/pick Win or Loss/);
    expect((await save(COACH, "2026-11-14-2", { format: 2, sets: [{ us: 25, them: 20 }, { us: 20, them: 25 }], result: "L" })).status).toBe(200);
    expect((await save(COACH, "2026-11-16-1", { format: 3 })).body.message).toMatch(/isn't part of the tournament/);
    expect((await save(COACH, "2026-11-14-13", { format: 3 })).status).toBe(400);
    expect((await save(COACH, "2026-11-10-1", { format: 3 }, "pr")).status).toBe(404);
    expect((await save(COACH, "2026-11-14-3", { format: 4 })).status).toBe(400);
    expect((await save(COACH, "2026-11-14-3", { format: 3, extra: 1 })).status).toBe(400);
  });

  it("is staff only until a parent is made the tournament's scorekeeper, then just for that tournament", async () => {
    expect((await save(MIA, "2026-11-14-3", { format: 3 })).status).toBe(403);
    expect((await save(FOOD, "2026-11-14-3", { format: 3 })).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/events/fc/scorekeeper`, MIA, { sub: MIA })).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/events/fc/scorekeeper`, COACH, { sub: FOOD })).body.message).toMatch(/has to be a parent/);
    expect((await call("PUT", `/teams/${T}/events/fc/scorekeeper`, COACH, { sub: MIA })).status).toBe(200);
    expect((await save(MIA, "2026-11-14-3", { opponent: "Northside", format: 3, sets: [{ us: 19, them: 25 }, { us: 22, them: 25 }] })).body.match.result).toBe("L");
    expect((await save(DAN, "2026-11-14-4", { format: 3 })).status).toBe(403);
    expect((await save(MIA, "2026-10-31-1", { format: 3 }, "hb")).status).toBe(403);
    expect((await bundle(DAN)).matches.fc.scorekeeper).toBe(MIA);
    // Taking it away ends it.
    expect((await call("PUT", `/teams/${T}/events/fc/scorekeeper`, COACH, { sub: null })).status).toBe(200);
    expect((await save(MIA, "2026-11-14-3", { format: 3 })).status).toBe(403);
    expect((await bundle(DAN)).matches.fc.scorekeeper).toBeUndefined();
  });

  it("adds and removes rows, never below what's entered", async () => {
    const slots = (who: string, date: string, n: number) => call("PUT", `/teams/${T}/events/fc/matchslots`, who, { date, slots: n });
    expect((await slots(COACH, "2026-11-14", 4)).status).toBe(200);
    expect((await save(COACH, "2026-11-14-4", { opponent: "Metro", format: 3, sets: [{ us: 25, them: 23 }, { us: 25, them: 22 }] })).status).toBe(200);
    expect((await slots(COACH, "2026-11-14", 3)).body.message).toMatch(/Clear the last match/);
    expect((await slots(COACH, "2026-11-15", 2)).status).toBe(200);
    expect((await slots(MIA, "2026-11-15", 5)).status).toBe(403);
    await call("PUT", `/teams/${T}/events/fc/scorekeeper`, COACH, { sub: MIA });
    expect((await slots(MIA, "2026-11-15", 3)).status).toBe(200);
    expect((await slots(MIA, "2026-11-15", 2)).body.message).toMatch(/Only coaches/);
    expect((await slots(COACH, "2026-11-20", 3)).status).toBe(400);
    const doc = (await bundle(COACH)).matches.fc;
    expect(M.tournamentView(doc, ["2026-11-14", "2026-11-15"]).days.map((d) => d.rows.length)).toEqual([4, 3]);
    expect(M.record(M.tournamentView(doc, ["2026-11-14", "2026-11-15"]).totals)).toBe("2–2");
    // Clearing a match empties its row.
    expect((await call("DELETE", `/teams/${T}/events/fc/matches/2026-11-14-4`, COACH)).status).toBe(204);
    expect((await bundle(COACH)).matches.fc.matches["2026-11-14-4"]).toBeUndefined();
  });

  it("is hidden and locked when the team turns the feature off", async () => {
    expect((await owner("PUT", `/teams/${T}/features`, { features: { matches: false } })).status).toBe(200);
    expect((await bundle(MIA)).matches).toEqual({});
    expect((await save(COACH, "2026-11-14-5", { format: 3 })).status).toBe(409);
    expect((await owner("PUT", `/teams/${T}/features`, { features: { matches: true } })).status).toBe(200);
    expect((await bundle(MIA)).matches.fc).toBeTruthy();
  });

  it("tells live pages that the matches changed", () => {
    expect(describeChange(`TEAM#${T}`, "EVENT#fc#MATCHES")).toEqual({ teamId: T, collection: "matches" });
  });
});
