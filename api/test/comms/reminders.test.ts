import { beforeAll, beforeEach, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-reminders";
process.env.MAIL_TRANSPORT = "memory";
process.env.SITE_URL = "https://dev.teemhub.net";
process.env.API_URL = "https://api-dev.teemhub.net";
process.env.APP_ENV = "dev";
const { event, freshTable } = await import("../api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { memoryOutbox } = await import("../../src/lib/mail/outbox.js");
const { runPlanner } = await import("../../src/lib/comms/planner.js");
const { forgetKey, readAnswer } = await import("../../src/lib/comms/tokens.js");
const { PutCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string | null, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const get = async (key: { PK: string; SK: string }) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
const T = "r13";
const member = (sub: string, roles: string[], email: string, firstName: string, pid = "") =>
  put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles, pid, email, firstName });
const turnOn = (messages: Record<string, unknown>) => owner("PUT", `/teams/${T}/comms`, { messages });
const to = (addr: string) => memoryOutbox.filter((m) => m.to === addr);

beforeAll(async () => {
  await freshTable();
  forgetKey();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  await owner("PUT", "/me", { firstName: "Sam", lastName: "Owner" });
  expect((await owner("POST", "/clubs", { clubId: "rc", name: "Reminder Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "rc", teamId: T, name: "Rem 13" })).status).toBe(201);
  const settings = (await get(keys.settings(T)))!;
  await put({ ...settings, dues: { amountCents: 30000, due: "2026-11-15", label: "Season dues" } });
  await put({ ...keys.event(T, "pr1"), type: "Event", eid: "pr1", kind: "practice", title: "Practice", date: "2026-10-06", time: "6:00 PM", endTime: "8:00 PM", location: "Main gym",
    repeat: { every: 1, days: [2], until: "2026-12-31", skipTournaments: true } });
  await put({ ...keys.event(T, "t1"), type: "Event", eid: "t1", kind: "tournament", title: "Fall Classic", date: "2026-11-07", endDate: "2026-11-08", travel: true,
    location: "Eastside Sports Center", city: "Columbus", arrival: "7:15 AM", uniforms: "Red jerseys", checklist: ["Water bottle", "Knee pads"], hotel: "Example Inn", hotelBy: "Oct 30", cartPid: "p2" });
  await put({ ...keys.player(T, "p1"), type: "Player", first: "Maya", last: "Parker" });
  await put({ ...keys.player(T, "p2"), type: "Player", first: "Ella", last: "Moss" });
  await put({ ...keys.family(T, "p1"), type: "Family", rsvp: { "pr1-2026-11-03": { v: "yes" } }, travel: { t1: { mode: "Driving" } } });
  await put({ ...keys.meal(T, "t1", "m1"), type: "Meal", meal: "Saturday lunch", day: "2026-11-07", claimedBy: "p1" });
  await put({ ...keys.ledger(T, "l1"), type: "Ledger", kind: "in", cat: "Dues", pid: "p1", amountCents: 10000, date: "2026-10-01" });
  await put({ ...keys.ledger(T, "l2"), type: "Ledger", kind: "in", cat: "Dues", pid: "p2", amountCents: 30000, date: "2026-10-01" });
  await member("u-jo", ["parent"], "jo@example.com", "Jo", "p1");
  await member("u-el", ["parent"], "el@example.com", "Eli", "p2");
  await member("u-coach", ["coach"], "coach@example.com", "Pat");
});
beforeEach(() => { memoryOutbox.length = 0; });

describe("tournament packet", () => {
  it("goes a week before, with each family's own jobs and what's missing", async () => {
    expect((await turnOn({ packet: { on: true } })).status).toBe(200);
    const page = (await owner("GET", `/teams/${T}/comms`)).body;
    expect(page.messages.find((m: any) => m.id === "packet")).toMatchObject({ schedule: "7 days before the tournament, at 9:00 AM", reach: 2 });
    // Saturday Oct 31, 9 AM Eastern (daylight time) = 13:00 UTC.
    const r = await runPlanner(new Date("2026-10-31T13:05:00Z"));
    expect(r.sends.map((s) => s.key)).toEqual(["packet:t1"]);
    expect(memoryOutbox.map((m) => m.to).sort()).toEqual(["el@example.com", "jo@example.com"]);
    const jo = to("jo@example.com")[0];
    expect(jo.subject).toBe("Fall Classic packet · Sat, Nov 7 – Sun, Nov 8");
    expect(jo.text).toContain("Arrive: 7:15 AM");
    expect(jo.text).toContain("- Knee pads");
    expect(jo.text).toContain("Team hotel: Example Inn, book by Oct 30");
    expect(jo.text).toContain("You signed up for Saturday lunch");
    expect(jo.text).not.toContain("travel plans aren't in");
    const el = to("el@example.com")[0];
    expect(el.text).toContain("Your travel plans aren't in yet.");
    expect(el.text).toContain("Your family brings the ball cart.");
    expect((await runPlanner(new Date("2026-10-31T13:20:00Z"))).sends).toEqual([]);
  });
});

describe("availability reminder", () => {
  it("asks only families who haven't answered, with links that answer in one tap", async () => {
    expect((await turnOn({ availability: { on: true } })).status).toBe(200);
    // Sunday Nov 1, 6 PM Eastern (standard time from today) = 23:00 UTC, for Tuesday's practice.
    const r = await runPlanner(new Date("2026-11-01T23:05:00Z"));
    expect(r.sends.find((s) => s.key === "availability:2026-11-01")).toMatchObject({ queued: 1, empty: 1 });
    const el = to("el@example.com")[0];
    expect(el.subject).toBe("Can Ella make Tue's practice?");
    const links = [...el.text.matchAll(/(In|Maybe|Out): (https:\/\/dev\.teemhub\.net\/answer#t=\S+)/g)].map((m) => [m[1], m[2]]);
    expect(links.map((l) => l[0])).toEqual(["In", "Maybe", "Out"]);
    const yes = links[0][1].split("#t=")[1];

    const peek = await call("POST", "/public/answer", null, { t: yes, peek: true });
    expect(peek.body).toMatchObject({ teamName: "Rem 13", player: "Ella", title: "Practice", date: "Tue, Nov 3", answer: "yes", current: "", recorded: false });
    expect((await get(keys.family(T, "p2")))?.rsvp?.["pr1-2026-11-03"]).toBeUndefined();
    const done = await call("POST", "/public/answer", null, { t: yes });
    expect(done.body).toMatchObject({ recorded: true, current: "yes" });
    expect((await get(keys.family(T, "p2")))!.rsvp["pr1-2026-11-03"]).toMatchObject({ v: "yes", by: "u-el", via: "email" });

    expect((await call("POST", "/public/answer", null, { t: yes.replace(/.$/, "x") })).status).toBe(400);
    expect(await readAnswer(yes, Date.parse("2026-11-06T00:00:00Z") / 1000)).toBe("expired");
    // Someone who's left the team can't use their old link.
    await put({ ...keys.member(T, "u-el"), ...keys.memberGsi(T, "u-el"), type: "Membership", status: "removed", sub: "u-el", roles: ["parent"], pid: "p2" });
    expect((await call("POST", "/public/answer", null, { t: yes })).status).toBe(404);
    await member("u-el", ["parent"], "el@example.com", "Eli", "p2");
  });

  it("skips the reminder when the weekly email just asked", async () => {
    expect((await turnOn({ weekly: { on: true, time: "17:00" } })).status).toBe(200);
    const r = await runPlanner(new Date("2026-11-08T23:05:00Z"));
    expect(r.sends.map((s) => [s.key, s.queued])).toEqual([["weekly:2026-11-08", 2], ["availability:2026-11-08", 0]]);
    expect(memoryOutbox.every((m) => m.subject.includes("your week"))).toBe(true);
    expect((await turnOn({ weekly: { on: false } })).status).toBe(200);
  });
});

describe("dues reminder", () => {
  it("goes to families who still owe, and once more the day after when asked", async () => {
    expect((await turnOn({ dues: { on: true, rules: { late: true } } })).status).toBe(200);
    // Tuesday Nov 10, 9 AM Eastern = 14:00 UTC.
    const r = await runPlanner(new Date("2026-11-10T14:05:00Z"));
    expect(r.sends.find((s) => s.key === "dues:2026-11-15")).toMatchObject({ queued: 1 });
    const jo = to("jo@example.com").find((m) => m.subject.includes("dues"))!;
    expect(jo.subject).toBe("Rem 13: $200 in dues due Sun, Nov 15");
    expect(jo.text).toContain("Total $300, paid $100.");
    expect(to("el@example.com").filter((m) => m.subject.includes("dues"))).toEqual([]);
    memoryOutbox.length = 0;
    await runPlanner(new Date("2026-11-16T14:05:00Z"));
    expect(to("jo@example.com").find((m) => m.subject.includes("dues"))!.subject).toBe("Rem 13: dues were due Sun, Nov 15");
  });
});

describe("payment recorded", () => {
  it("confirms a family's payment and a reimbursement, once each", async () => {
    expect((await turnOn({ payment: { on: true } })).status).toBe(200);
    const pay = await call("POST", `/teams/${T}/payments`, "u-jo", { kind: "in", cat: "Dues", pid: "p1", amountCents: 5000, date: "2026-11-12", desc: "Dues" });
    expect(pay.status).toBe(201);
    expect(memoryOutbox).toEqual([]); // not until finance records it
    expect((await owner("POST", `/teams/${T}/payments/${pay.body.payId}/confirm`)).status).toBe(200);
    const jo = to("jo@example.com")[0];
    expect(jo.subject).toBe("Payment recorded: $50 for Maya");
    expect(jo.text).toContain("Dues left: $150");
    expect((await owner("POST", `/teams/${T}/payments/${pay.body.payId}/confirm`)).status).toBe(409);
    expect(memoryOutbox).toHaveLength(1);

    memoryOutbox.length = 0;
    const back = await call("POST", `/teams/${T}/payments`, "u-coach", { kind: "out", cat: "Reimbursement", amountCents: 2500, date: "2026-11-12", desc: "Pizza" });
    expect((await owner("POST", `/teams/${T}/payments/${back.body.payId}/confirm`)).status).toBe(200);
    expect(memoryOutbox.map((m) => [m.to, m.subject])).toEqual([["coach@example.com", "Reimbursement approved: $25"]]);

    memoryOutbox.length = 0;
    expect((await owner("PUT", `/teams/${T}/ledger/l9`, { kind: "in", cat: "Dues", pid: "p2", amountCents: 1000, date: "2026-11-12", desc: "Extra" })).status).toBe(200);
    expect(memoryOutbox.map((m) => m.to)).toEqual(["el@example.com"]);
    expect((await owner("PUT", `/teams/${T}/ledger/l9`, { kind: "in", cat: "Dues", pid: "p2", amountCents: 1200, date: "2026-11-12", desc: "Extra" })).status).toBe(200);
    expect(memoryOutbox).toHaveLength(1); // an edit isn't a new payment
  });
});

describe("announcement emails", () => {
  it("emails a post when asked, once, at most twice a week", async () => {
    expect((await call("GET", `/teams/${T}`, "u-coach")).body.emailPosts).toBe(false);
    const off = await call("PUT", `/teams/${T}/announcements/a1`, "u-coach", { text: "Gym closed tonight.", email: true });
    expect(off.body).toMatchObject({ aid: "a1", emailed: 0, reason: "off" });
    expect((await turnOn({ announcement: { on: true } })).status).toBe(200);
    expect((await call("GET", `/teams/${T}`, "u-coach")).body.emailPosts).toBe(true);
    expect((await call("GET", `/teams/${T}`, "u-jo")).body.emailPosts).toBe(false);

    const r = await call("PUT", `/teams/${T}/announcements/a2`, "u-coach", { text: "Uniform pickup Thursday.\nBring the size form.", pinned: true, email: true });
    expect(r.body).toMatchObject({ aid: "a2", emailed: 2 });
    expect(memoryOutbox.map((m) => m.to).sort()).toEqual(["el@example.com", "jo@example.com"]); // not the poster
    expect(memoryOutbox[0]).toMatchObject({ subject: "Rem 13: Uniform pickup Thursday.", fromName: "Your coach via Teem Hub (dev)" });
    expect((await call("PUT", `/teams/${T}/announcements/a2`, "u-coach", { text: "Uniform pickup Thursday (updated).", pinned: true, email: true })).body).toMatchObject({ emailed: 0, reason: "already" });
    expect((await get(keys.announcement(T, "a2")))!.emailedAt).toBeTruthy();
    expect((await call("PUT", `/teams/${T}/announcements/a3`, "u-coach", { text: "Second one.", email: true })).body.emailed).toBe(2);
    expect((await call("PUT", `/teams/${T}/announcements/a4`, "u-coach", { text: "Third one.", email: true })).body).toMatchObject({ emailed: 0, reason: "cap" });
    expect((await call("PUT", `/teams/${T}/announcements/a5`, "u-jo", { text: "Parents can't post.", email: true })).status).toBe(403);
  });
});

describe("previews", () => {
  it("previews every message from the team's records", async () => {
    for (const msg of ["packet", "availability", "dues", "payment", "announcement"]) {
      const r = await owner("GET", `/teams/${T}/comms/${msg}/preview`);
      expect([msg, r.status]).toEqual([msg, 200]);
      expect(r.body.html).toContain("Rem 13");
    }
  });
});

describe("upcoming sends", () => {
  it("lists reminders from the team's schedule alongside the weekly ones", async () => {
    const { occurrences } = await import("../../src/lib/comms/planner.js");
    const { loadTeam } = await import("../../src/lib/comms/content.js");
    const t = await loadTeam(T, "rc");
    const c = { messages: { packet: { on: true }, availability: { on: true }, dues: { on: true, rules: { late: true } }, weekly: { on: true } } };
    const keys14 = occurrences(c, new Date("2026-10-30T12:00:00Z"), 14, t).map((o) => o.key);
    expect(keys14).toEqual(expect.arrayContaining(["packet:t1", "weekly:2026-11-01", "availability:2026-11-01", "dues:2026-11-15", "weekly:2026-11-08"]));
    expect(keys14).not.toContain("dues-late:2026-11-15"); // Nov 16 is past the two weeks
    // The team fund off: no dues reminders.
    expect(occurrences(c, new Date("2026-10-30T12:00:00Z"), 14, { ...t, features: { fund: false } }).map((o) => o.key)).not.toContain("dues:2026-11-15");
  });
});
