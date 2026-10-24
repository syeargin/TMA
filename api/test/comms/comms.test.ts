import { beforeAll, beforeEach, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-comms";
process.env.MAIL_TRANSPORT = "memory";
process.env.SITE_URL = "https://dev.teemhub.net";
process.env.API_URL = "https://api-dev.teemhub.net";
process.env.APP_ENV = "dev";
const { event, freshTable } = await import("../api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { memoryOutbox } = await import("../../src/lib/mail/outbox.js");
const { runPlanner, occurrences, dueNow } = await import("../../src/lib/comms/planner.js");
const { buildItems } = await import("../../src/lib/comms/schedule.js");
const { zonedInstant, localParts } = await import("../../src/lib/comms/zoned.js");
const { forgetKey } = await import("../../src/lib/comms/tokens.js");
const web = await import("../../../web/src/app/core/schedule.js");
const { PutCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string | null, body?: unknown, email?: string, query = ""): Promise<Res> {
  const ev = event(method, path, sub, body, email);
  (ev as any).rawQueryString = query;
  const r = await handler(ev);
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const member = (sub: string, roles: string[], email: string, firstName: string, pid = "") =>
  put({ ...keys.member("c13", sub), ...keys.memberGsi("c13", sub), type: "Membership", status: "active", sub, roles, pid, email, firstName });

const T = "c13";
// Sunday Nov 1, 2026: the day US clocks go back, so 6 PM Eastern is 23:00 UTC.
const SUNDAY_6PM = new Date("2026-11-01T23:00:00Z");

const EVENTS = [
  { eid: "pr1", kind: "practice", title: "Practice", date: "2026-10-06", time: "6:00 PM", endTime: "8:00 PM", location: "Main gym",
    repeat: { every: 1, days: [2, 4], until: "2026-12-31", skipTournaments: true }, cancelled: ["2026-11-05"], overrides: { "2026-11-03": { location: "West gym" } } },
  { eid: "t1", kind: "tournament", title: "Fall Classic", date: "2026-11-07", endDate: "2026-11-08", travel: true, city: "Columbus" },
  { eid: "d1", kind: "deadline", title: "Uniform sizes due", date: "2026-11-04" },
  { eid: "x1", kind: "event", title: "Team dinner", date: "2026-11-20", time: "7:00 PM" }
];

beforeAll(async () => {
  await freshTable();
  forgetKey();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "cc", name: "Comms Club", colors: { primary: "#1F4E3D", accent: "#E0A526" } })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "cc", teamId: T, name: "Comms 13" })).status).toBe(201);
  const settings = (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.settings(T) }))).Item!;
  await put({ ...settings, dues: { amountCents: 30000, due: "2026-11-15" } });
  for (const e of EVENTS) await put({ ...keys.event(T, e.eid), type: "Event", ...e });
  await put({ ...keys.player(T, "p1"), type: "Player", first: "Maya", last: "Parker" });
  await put({ ...keys.player(T, "p2"), type: "Player", first: "Ella", last: "Moss" });
  await put({ ...keys.family(T, "p1"), type: "Family", rsvp: { "pr1-2026-11-03": { v: "yes" } }, travel: { t1: { mode: "Driving" } } });
  await put({ ...keys.meal(T, "t1", "m1"), type: "Meal", meal: "Saturday lunch", day: "2026-11-07", claimedBy: "p1" });
  await put({ ...keys.meal(T, "t1", "m2"), type: "Meal", meal: "Sunday lunch", day: "2026-11-08", claimedBy: null });
  await put({ ...keys.ledger(T, "l1"), type: "Ledger", kind: "in", cat: "Dues", pid: "p1", amountCents: 10000, date: "2026-10-01" });
  await put({ ...keys.ledger(T, "l2"), type: "Ledger", kind: "in", cat: "Dues", pid: "p2", amountCents: 30000, date: "2026-10-01" });
  await put({ ...keys.announcement(T, "a1"), type: "Announcement", text: "Jerseys are in!", pinned: true });
  await put({ ...keys.task(T, "k1"), type: "Task", title: "Order warm-ups", owner: "Pat", status: "To do" });
  await member("u-jo", ["parent"], "jo@example.com", "Jo", "p1");
  await member("u-el", ["parent"], "el@example.com", "Eli", "p2");
  await member("u-coach", ["coach", "admin"], "coach@example.com", "Pat");
  await member("u-food", ["food", "parent"], "food@example.com", "Fay", "p2");
});
beforeEach(() => { memoryOutbox.length = 0; });

describe("the team's week, worked out on the server", () => {
  it("matches the site's schedule exactly", () => {
    const settings = { practices: [{ id: "old", label: "Old practice", dow: 1, start: "5:00 PM", from: "2026-10-05", until: "2026-11-30" }], cancelled: ["pr-old-2026-11-02"] };
    const strip = (items: any[]) => items.map((i) => ({ key: i.key, kind: i.kind, title: i.title, date: i.date, end: i.end, time: i.time, location: i.location, note: i.note, travel: i.travel, cancelled: i.cancelled }));
    expect(strip(buildItems(EVENTS, settings))).toEqual(strip(web.buildItems(EVENTS as any, settings as any)));
  });

  it("handles time zones and the clocks going back", () => {
    expect(zonedInstant("2026-10-25", "18:00", "America/New_York").toISOString()).toBe("2026-10-25T22:00:00.000Z");
    expect(zonedInstant("2026-11-01", "18:00", "America/New_York").toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(zonedInstant("2026-11-01", "18:00", "America/Los_Angeles").toISOString()).toBe("2026-11-02T02:00:00.000Z");
    expect(localParts(SUNDAY_6PM, "America/New_York")).toEqual({ date: "2026-11-01", hhmm: "18:00", dow: 0 });
    const c = { messages: { weekly: { on: true } } };
    expect(occurrences(c, new Date("2026-10-30T12:00:00Z"), 14).map((o) => o.key)).toEqual(["weekly:2026-11-01", "weekly:2026-11-08"]);
    expect(dueNow(c, new Date("2026-11-01T22:59:00Z"))).toEqual([]);
    expect(dueNow(c, new Date("2026-11-01T23:10:00Z")).map((o) => o.key)).toEqual(["weekly:2026-11-01"]);
    expect(dueNow(c, new Date("2026-11-02T03:00:00Z"))).toEqual([]); // more than 3 hours late
  });
});

describe("the Communications page", () => {
  it("starts with everything off, and is for admins and coordinators", async () => {
    const r = await owner("GET", `/teams/${T}/comms`);
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: any) => [m.id, m.settings.on])).toEqual(["weekly", "staffDigest", "packet", "availability", "dues", "payment", "announcement"].map((m) => [m, false]));
    expect(r.body.upcoming).toEqual([]);
    expect(r.body.timeZone).toBe("America/New_York");
    expect((await call("GET", `/teams/${T}/comms`, "u-jo")).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/comms`, "u-jo", { messages: { weekly: { on: true } } })).status).toBe(403);
    expect((await call("GET", `/teams/${T}/comms`, "u-coach")).status).toBe(200);
  });

  it("saves choices and shows the next two weeks of sends", async () => {
    expect((await owner("PUT", `/teams/${T}/comms`, { messages: { weekly: { on: true, day: 0, time: "18:00", rules: { bogus: true } }, staffDigest: { on: true, time: "17:30" } } })).status).toBe(200);
    expect((await owner("PUT", `/teams/${T}/comms`, { messages: { weekly: { time: "18:10" } } })).status).toBe(400);
    expect((await owner("PUT", `/teams/${T}/comms`, { timeZone: "Mars/Olympus" })).status).toBe(400);
    const r = await owner("GET", `/teams/${T}/comms`);
    const weekly = r.body.messages.find((m: any) => m.id === "weekly");
    expect(weekly).toMatchObject({ schedule: "on Sundays at 6:00 PM", reach: 3, settings: { on: true, rules: { skipEmpty: true, hideEmpty: true } } });
    expect(weekly.settings.rules.bogus).toBeUndefined();
    expect(r.body.messages.find((m: any) => m.id === "staffDigest")).toMatchObject({ schedule: "on Sundays at 5:30 PM", reach: 2 });
    expect(r.body.upcoming.length).toBeGreaterThanOrEqual(2);
  });

  it("previews this week's email from the team's own records", async () => {
    const r = await owner("GET", `/teams/${T}/comms/weekly/preview`);
    expect(r.status).toBe(200);
    expect(r.body.family).toBe("Maya");
    expect(r.body.html).toContain("Comms 13");
    expect((await owner("GET", `/teams/${T}/comms/bogus/preview`)).status).toBe(404);
    expect((await owner("POST", `/teams/${T}/comms/staffDigest/test`)).body).toEqual({ to: "owner@example.com" });
    expect(memoryOutbox[0].subject).toContain("staff digest");
  });
});

describe("the planner", () => {
  it("sends each family its own week, and each staff member what their role can see", async () => {
    const r = await runPlanner(new Date("2026-11-01T22:35:00Z")); // 5:35 PM: the staff digest is due, the weekly isn't yet
    expect(r.sends.map((s) => s.key)).toEqual(["staffDigest:2026-11-01"]);
    const coach = memoryOutbox.find((m) => m.to === "coach@example.com")!;
    expect(coach.subject).toBe("Comms 13: staff digest for Mon, Nov 2 – Sun, Nov 8");
    expect(coach.text).toContain("HAVEN'T ANSWERED");
    expect(coach.text).toContain("Tue, Nov 3 · Practice: Ella M.");
    expect(coach.text).toContain("Order warm-ups");
    expect(coach.text).toContain("DUES STILL OWED (due Sun, Nov 15): Maya P."); // a team admin sees the ledger
    const food = memoryOutbox.find((m) => m.to === "food@example.com")!;
    expect(food.text).toContain("OPEN MEAL SIGN-UPS");
    expect(food.text).toContain("Sunday lunch");
    expect(food.text).not.toContain("HAVEN'T ANSWERED");
    expect(food.text).not.toContain("DUES");
    expect(food.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });

    memoryOutbox.length = 0;
    const r2 = await runPlanner(SUNDAY_6PM);
    expect(r2.sends.map((s) => s.key)).toEqual(["weekly:2026-11-01"]);
    expect(memoryOutbox.map((m) => m.to).sort()).toEqual(["el@example.com", "food@example.com", "jo@example.com"]);
    const jo = memoryOutbox.find((m) => m.to === "jo@example.com")!;
    expect(jo.fromName).toBe("Comms 13 via Teem Hub (dev)");
    expect(jo.subject).toBe("Comms 13: your week, Mon, Nov 2 – Sun, Nov 8 · 1 to answer");
    expect(jo.text).toContain("Your week, Jo");
    expect(jo.text).toContain("for Maya");
    expect(jo.text).toContain("West gym");              // that date's own location
    expect(jo.text).toContain("(CANCELLED)");           // Thursday's practice
    expect(jo.text).not.toContain("Tue, Nov 3 · Practice (");  // answered already
    expect(jo.text).toContain("Sat, Nov 7 · Fall Classic");
    expect(jo.text).toContain("- Saturday lunch · Fall Classic");
    expect(jo.text).toContain("MONEY: $200 in dues due Sun, Nov 15");
    expect(jo.text).toContain("Jerseys are in!");
    expect(jo.text).not.toContain("Team dinner");       // not this week
    expect(jo.html).toContain("#1F4E3D");
    const el = memoryOutbox.find((m) => m.to === "el@example.com")!;
    expect(el.text).not.toContain("MONEY");             // paid up
    expect(el.text).not.toContain("Maya");
  });

  it("sends once, however many times it runs", async () => {
    expect((await runPlanner(new Date("2026-11-01T23:20:00Z"))).sends).toEqual([]);
    expect(memoryOutbox).toEqual([]);
  });

  it("leaves out people who unsubscribed, from the link or their settings", async () => {
    const r = await runPlanner(new Date("2026-11-08T23:05:00Z"));
    const jo = memoryOutbox.find((m) => m.to === "jo@example.com")!;
    expect(r.sends.find((s) => s.key === "weekly:2026-11-08")).toBeTruthy();
    const t = /\?t=([^>]+)>/.exec(jo.headers!["List-Unsubscribe"])![1];
    // The mail app's one-click POST: no sign-in, a form body.
    const r1 = await handler({ ...event("POST", "/public/unsubscribe", null), rawQueryString: `t=${t}`, body: "List-Unsubscribe=One-Click" } as any);
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body as string)).toMatchObject({ teamName: "Comms 13", message: "Weekly at-a-glance", off: true });
    expect((await call("POST", "/public/unsubscribe", null, { t: t.slice(0, -3) + "AAA" })).status).toBe(400);
    expect((await call("POST", "/public/unsubscribe", null, { t: t.replace(/^./, "x") })).status).toBe(400);

    const mine = await call("GET", "/me/notifications", "u-jo");
    expect(mine.body.teams[0]).toMatchObject({ teamId: T, off: ["weekly"] });
    expect(mine.body.teams[0].options.map((o: any) => [o.id, o.teamSends])).toEqual([["weekly", true], ["packet", false], ["availability", false], ["dues", false], ["payment", false], ["announcement", false]]);
    expect((await call("GET", "/me/notifications", "u-coach")).body.teams[0].options.map((o: any) => o.id)).toEqual(["weekly", "staffDigest", "packet", "payment", "announcement"]);
    expect((await call("PUT", `/me/notifications/${T}`, "u-el", { off: ["weekly", "weekly"] })).body).toEqual({ teamId: T, off: ["weekly"] });
    expect((await call("PUT", `/me/notifications/${T}`, "u-el", { off: ["invite"] })).status).toBe(400);
    expect((await call("PUT", `/me/notifications/other`, "u-el", { off: [] })).status).toBe(404);

    memoryOutbox.length = 0;
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: "x", SK: "y" } }));
    const r2 = await runPlanner(new Date("2026-11-15T23:05:00Z"));
    expect(r2.sends.find((s) => s.key === "weekly:2026-11-15")).toBeTruthy();
    expect(memoryOutbox.filter((m) => m.subject.includes("your week")).map((m) => m.to)).toEqual(["food@example.com"]);
    // Undo from the unsubscribe page.
    expect((await call("POST", "/public/unsubscribe", null, { t, undo: true })).body.off).toBe(false);
  });

  it("skips one send, a paused team, and a week with nothing on", async () => {
    expect((await owner("PUT", `/teams/${T}/comms/skip`, { key: "weekly:2026-11-22", skip: true })).status).toBe(200);
    memoryOutbox.length = 0;
    expect((await runPlanner(new Date("2026-11-22T23:05:00Z"))).sends.map((s) => s.key)).toEqual(["staffDigest:2026-11-22"]);
    expect((await owner("PUT", `/teams/${T}/comms`, { pauseUntil: "2026-12-31" })).status).toBe(200);
    expect((await runPlanner(new Date("2026-11-29T23:05:00Z"))).sends).toEqual([]);
    expect((await owner("PUT", `/teams/${T}/comms`, { pauseUntil: null })).status).toBe(200);
    // January 3: practices are over and nothing is scheduled. Only the family with dues still owed gets an email.
    memoryOutbox.length = 0;
    const r = await runPlanner(new Date("2027-01-03T23:05:00Z"));
    expect(r.sends.find((s) => s.key === "weekly:2027-01-03")).toMatchObject({ queued: 1, empty: 1 });
    expect(memoryOutbox.filter((m) => m.subject.includes("your week")).map((m) => m.to)).toEqual(["jo@example.com"]);
    expect(memoryOutbox.find((m) => m.to === "jo@example.com")!.text).toContain("was due Sun, Nov 15");
  });
});
