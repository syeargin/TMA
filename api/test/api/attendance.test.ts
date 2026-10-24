import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-attendance";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { summarize, suggestedMark } = await import("../../src/shared/attendance.js");
type AttendanceRecord = import("../../src/shared/attendance.js").AttendanceRecord;
const { PutCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COACH = "u-coach", COACH2 = "u-coach2", JO = "u-jo", FOOD = "u-food";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const coach = (m: string, p: string, b?: unknown) => call(m, p, COACH, b, "coach@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const T = "a13";
const member = (sub: string, roles: string[], pid = "") => put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles, pid });
const take = (who: string, key: string, marks: Record<string, unknown>) => call("PUT", `/teams/${T}/attendance/${key}`, who, { marks });
const bundle = async (who: string) => (await call("GET", `/teams/${T}`, who)).body;

// Tuesdays: two in the past, and the first one after today (never takeable yet).
const tuesdayAfterToday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const P1 = "pr1-2026-10-06", P2 = "pr1-2026-10-13", P3 = "pr1-2026-10-20";

beforeAll(async () => {
  await freshTable();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "ac", name: "Att Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "ac", teamId: T, name: "Att 13" })).status).toBe(201);
  await put({ ...keys.event(T, "pr1"), type: "Event", eid: "pr1", kind: "practice", title: "Practice", date: "2026-10-06", time: "6:00 PM",
    repeat: { every: 1, days: [2], until: "2030-06-30" }, cancelled: ["2026-10-20"] });
  await put({ ...keys.event(T, "t1"), type: "Event", eid: "t1", kind: "tournament", title: "Fall Classic", date: "2026-10-10" });
  for (const [pid, first] of [["p1", "Maya"], ["p2", "Ella"], ["p3", "Ava"]]) await put({ ...keys.player(T, pid), type: "Player", first, last: "X" });
  await member(COACH, ["coach"]); await member(COACH2, ["coach"]); await member(JO, ["parent"], "p1"); await member(FOOD, ["food"]);
});

describe("taking attendance", () => {
  it("is for coaches, coordinators and admins, on practices that have happened", async () => {
    expect((await take(JO, P1, { p1: { s: "present" } })).status).toBe(403);
    expect((await take(FOOD, P1, { p1: { s: "present" } })).status).toBe(403);
    expect((await take(COACH, "t1", { p1: { s: "present" } })).body.message).toMatch(/Only practices/);
    expect((await take(COACH, P3, { p1: { s: "present" } })).body.message).toMatch(/cancelled/);
    expect((await take(COACH, `pr1-${tuesdayAfterToday()}`, { p1: { s: "present" } })).body.message).toMatch(/day of the practice/);
    expect((await take(COACH, P1, { p9: { s: "present" } })).body.message).toMatch(/aren't on this team/);
    expect((await take(COACH, P1, { p1: { s: "here" } })).status).toBe(400);
    const r = await take(COACH, P1, { p1: { s: "present" }, p2: { s: "late", note: "Arrived 6:20" }, p3: { s: "excused" } });
    expect(r.body).toMatchObject({ key: P1, date: "2026-10-06", marks: { p1: { s: "present" }, p2: { s: "late", note: "Arrived 6:20" }, p3: { s: "excused" } } });
  });

  it("keeps both coaches' marks when they save at once, and removes a mark sent as null", async () => {
    await Promise.all([take(COACH, P2, { p1: { s: "absent" } }), take(COACH2, P2, { p2: { s: "present" } })]);
    expect((await take(COACH, P2, { p3: { s: "present" } })).body.marks).toEqual({ p1: { s: "absent" }, p2: { s: "present" }, p3: { s: "present" } });
    expect((await take(COACH, P2, { p3: null })).body.marks).toEqual({ p1: { s: "absent" }, p2: { s: "present" } });
    const rec = (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.attendance(T, P2) }))).Item!;
    expect(rec).toMatchObject({ takenBy: expect.any(String), updatedBy: COACH });
  });
});

describe("who sees what", () => {
  it("staff see every player; a family sees only their own player's marks; others see none", async () => {
    const staff = await bundle(COACH);
    expect(staff.attendance.find((r: any) => r.key === P1).marks).toMatchObject({ p1: { s: "present" }, p2: { s: "late", note: "Arrived 6:20" } });
    const fam = await bundle(JO);
    expect(fam.attendance.map((r: any) => [r.key, r.marks])).toEqual(expect.arrayContaining([[P1, { p1: { s: "present" } }], [P2, { p1: { s: "absent" } }]]));
    expect(JSON.stringify(fam.attendance)).not.toMatch(/p2|p3|takenBy|Arrived/);
    expect((await bundle(FOOD)).attendance).toEqual([]);
    const exp = (await call("GET", "/me/export", JO)).body;
    expect(exp.teams[0].practiceAttendance).toEqual([{ date: "2026-10-06", s: "present" }, { date: "2026-10-13", s: "absent" }]);
  });

  it("turning the feature off hides it and stops changes", async () => {
    expect((await owner("PUT", `/teams/${T}/features`, { features: { attendance: false } })).status).toBe(200);
    expect((await bundle(COACH)).attendance).toEqual([]);
    expect((await take(COACH, P1, { p1: { s: "late" } })).body.error).toBe("feature_off");
    expect((await owner("PUT", `/teams/${T}/features`, { features: { attendance: true } })).status).toBe(200);
  });

  it("a removed player's marks go with them", async () => {
    expect((await owner("DELETE", `/teams/${T}/players/p3`)).status).toBe(204);
    const rec = (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.attendance(T, P1) }))).Item!;
    expect(Object.keys(rec.marks)).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect(rec.marks.p3).toBeUndefined();
  });
});

describe("the numbers", () => {
  const recs: AttendanceRecord[] = [
    { key: "a", date: "2026-10-06", marks: { p1: { s: "present"}, p2: { s: "excused"} } },
    { key: "b", date: "2026-10-08", marks: { p1: { s: "late"}, p2: { s: "absent"} } },
    { key: "c", date: "2026-10-13", marks: { p1: { s: "absent"} } },
    { key: "x", date: "2026-10-15", marks: { p1: { s: "present"} } }, // cancelled since: not in practices
    { key: "d", date: "2026-10-20", marks: {} } // opened but nobody marked: not taken
  ];
  const practices = new Set(["a", "b", "c", "d"]);

  it("counts present and late as attended, over the practices each player was marked at", () => {
    const s = summarize(recs, ["p1", "p2"], { practices });
    expect(s.taken).toBe(3);
    expect(s.players[0]).toMatchObject({ pid: "p1", present: 1, late: 1, absent: 1, marked: 3, attended: 2, counted: 3, rate: 67 });
    expect(s.players[1]).toMatchObject({ pid: "p2", excused: 1, absent: 1, marked: 2, attended: 0, rate: 0 });
    expect(s).toMatchObject({ attended: 2, counted: 5, teamRate: 40 });
    expect(s.players[0].last.map((l) => l.s)).toEqual(["present", "late", "absent"]);
  });

  it("can leave excused absences out of the percentage, and limit by date", () => {
    const s = summarize(recs, ["p2"], { practices, excusedCount: false });
    expect(s.players[0]).toMatchObject({ counted: 1, rate: 0 });
    expect(summarize(recs, ["p1"], { practices, from: "2026-10-08" }).players[0]).toMatchObject({ marked: 2, rate: 50 });
    expect(summarize([], ["p1"], { practices }).players[0].rate).toBeNull();
  });

  it("starts from the family's answer", () => {
    expect([suggestedMark("yes"), suggestedMark("no"), suggestedMark("maybe"), suggestedMark(undefined)]).toEqual(["present", "excused", undefined, undefined]);
  });
});
