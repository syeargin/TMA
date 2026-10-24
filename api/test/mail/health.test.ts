import { beforeAll, beforeEach, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-health";
process.env.MAIL_TRANSPORT = "memory";
process.env.SITE_URL = "https://dev.teemhub.net";
process.env.APP_ENV = "dev";
const { event, freshTable } = await import("../api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { applySesEvent, memoryOutbox } = await import("../../src/lib/mail/outbox.js");
const { runPlanner } = await import("../../src/lib/comms/planner.js");
const { suggestDomain } = await import("../../src/lib/mail/health.js");
const { startFollow } = await import("../../src/lib/mail/stats.js");
const { purgeTeam } = await import("../../src/lib/retention.js");
const { forgetKey } = await import("../../src/lib/comms/tokens.js");
const { PutCommand, QueryCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string | null, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const T = "h13";
const member = (sub: string, roles: string[], email: string, firstName: string, pid = "", notifyOff: string[] = []) =>
  put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles, pid, email, firstName, notifyOff });
const health = async () => (await owner("GET", `/teams/${T}/comms/health`)).body;
/** The delivery ids of the emails just sent to an address. */
const ids = (addr: string) => memoryOutbox.filter((m) => m.to === addr).map((m) => m.tags.delivery);
const ses = (eventType: string, id: string, extra: Record<string, unknown> = {}) => applySesEvent({ eventType, mail: { tags: { delivery: [id] } }, ...extra });

beforeAll(async () => {
  await freshTable();
  forgetKey();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "hc", name: "Health Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "hc", teamId: T, name: "Health 13" })).status).toBe(201);
  await put({ ...keys.event(T, "pr1"), type: "Event", eid: "pr1", kind: "practice", title: "Practice", date: "2026-10-06", time: "6:00 PM", location: "Main gym",
    repeat: { every: 1, days: [2], until: "2026-12-31" } });
  await put({ ...keys.player(T, "p1"), type: "Player", first: "Maya", last: "Parker" });
  await put({ ...keys.player(T, "p2"), type: "Player", first: "Ella", last: "Moss" });
  await put({ ...keys.player(T, "p3"), type: "Player", first: "Ana", last: "Kim" });
  await put({ ...keys.player(T, "p4"), type: "Player", first: "Lu", last: "Ortiz" });
  await member("u-jo", ["parent"], "jo@example.com", "Jo", "p1");
  await member("u-el", ["parent"], "el@example.com", "Eli", "p2");
  await member("u-kim", ["parent"], "kim@example.com", "Kai", "p3", ["all"]);
  await member("u-coach", ["coach"], "coach@example.com", "Pat");
});
beforeEach(() => { memoryOutbox.length = 0; });

describe("delivery health", () => {
  it("is only for people who manage the team's settings", async () => {
    expect((await call("GET", `/teams/${T}/comms/health`, "u-jo", undefined, "jo@example.com")).status).toBe(403);
    const h = await health();
    expect(h).toMatchObject({ sent: 0, delivered: 0, opensSince: null, messages: [] });
  });

  it("counts sends, deliveries and first opens by message", async () => {
    expect((await owner("PUT", `/teams/${T}/comms`, { messages: { weekly: { on: true } } })).status).toBe(200);
    // Sunday Nov 1, 6 PM Eastern.
    const r = await runPlanner(new Date("2026-11-01T23:05:00Z"));
    expect(r.sends.find((s) => s.key === "weekly:2026-11-01")?.queued).toBe(2);
    const [jo] = ids("jo@example.com");
    const [el] = ids("el@example.com");
    await ses("Delivery", jo);
    await ses("Delivery", el);
    await ses("Open", jo);
    await ses("Open", jo); // a second open doesn't count twice
    const h = await health();
    expect(h.messages).toEqual([expect.objectContaining({ id: "weekly", label: "Weekly at-a-glance", sent: 2, delivered: 2, opened: 1, next: 0, nextLabel: "", off: 1 })]);
    expect(h).toMatchObject({ sent: 2, delivered: 2, families: 2, familiesOpening: 1, turnedOff: 1 });
    expect(h.opensSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await owner("PUT", `/teams/${T}/comms`, { messages: { weekly: { on: false } } })).status).toBe(200);
  });

  it("lists families nobody can reach: no parent on Teem Hub, or every email turned off", async () => {
    const h = await health();
    const un = h.attention.filter((a: any) => a.kind === "unreachable");
    expect(un.map((a: any) => [a.family, a.why])).toEqual([
      ["Kim family", "Turned off team email, so they only see changes when they open Teem Hub."],
      ["Ortiz family", "No parent is on Teem Hub, so they don't get team email."]
    ]);
  });

  it("shows a bounced invite under Needs attention, with the likely typo", async () => {
    const inv = await owner("POST", `/teams/${T}/invites`, { email: "d.torres@gmial.com", roles: ["parent"], pid: "p4", firstName: "Dana", lastName: "Torres" });
    expect(inv.status).toBe(201);
    const [id] = ids("d.torres@gmial.com");
    await ses("Bounce", id, { bounce: { bounceType: "Permanent", bounceSubType: "General" } });
    const h = await health();
    expect(h.attention[0]).toMatchObject({ kind: "bounced", email: "d.torres@gmial.com", who: "Dana Torres", invite: true, bounces: 1, suggest: "gmail.com" });
    expect(h.messages.find((m: any) => m.id === "invite")).toMatchObject({ sent: 1, bounced: 1, off: null });
    expect(h.attention.find((a: any) => a.kind === "unreachable" && a.family === "Ortiz family").why).toMatch(/^Invited/);
    expect(h.count).toBe(h.attention.length);
    // Transient bounces (a full mailbox) aren't problems yet.
    await ses("Bounce", id, { bounce: { bounceType: "Transient" } });
    expect((await health()).attention[0].bounces).toBe(1);
  });

  it("shows a member who marked email as spam, and families who stopped opening", async () => {
    expect((await owner("PUT", `/teams/${T}/comms`, { messages: { weekly: { on: true } } })).status).toBe(200);
    for (const [i, d] of ["2026-11-08", "2026-11-15", "2026-11-22", "2026-11-29"].entries()) {
      memoryOutbox.length = 0;
      await runPlanner(new Date(`${d}T23:05:00Z`));
      for (const id of [...ids("jo@example.com"), ...ids("el@example.com")]) await ses("Delivery", id);
      if (i === 3) await ses("Complaint", ids("el@example.com")[0]);
    }
    const h = await health();
    expect(h.attention.find((a: any) => a.kind === "complained")).toMatchObject({ email: "el@example.com", who: "Eli" });
    // Jo opened the first weekly, then 4 more arrived unopened; but that open was within four weeks.
    expect(h.attention.find((a: any) => a.kind === "notOpening")).toBeUndefined();
    // Eli's address can't be reached now, so the Moss family is unreachable rather than "not opening".
    expect(h.attention.find((a: any) => a.kind === "unreachable" && a.family === "Moss family").why).toBe("Every parent's address bounced or marked team email as spam.");
    // Four weeks later, still nothing opened.
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: `MAILSTATS#${T}`, SK: "ADDR#jo@example.com", type: "MailAddress", email: "jo@example.com", sinceOpen: 5, delivered: 6, lastDeliveredAt: new Date().toISOString(), lastOpenAt: "2026-09-01T00:00:00Z" } }));
    const later = await health();
    expect(later.attention.find((a: any) => a.kind === "notOpening")).toMatchObject({ families: [{ family: "Parker family", pid: "p1", emails: 5, lastOpen: "2026-09-01T00:00:00Z" }] });
    expect((await owner("PUT", `/teams/${T}/comms`, { messages: { weekly: { on: false } } })).status).toBe(200);
  });

  it("counts what families did after a reminder: answered, paid", async () => {
    expect((await owner("PUT", `/teams/${T}/comms`, { messages: { availability: { on: true }, dues: { on: true } } })).status).toBe(200);
    const settings = (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p AND SK = :s", ExpressionAttributeValues: { ":p": `TEAM#${T}`, ":s": "META#SETTINGS" } }))).Items![0];
    await put({ ...settings, features: { ...(settings.features ?? {}), fund: true }, dues: { amountCents: 30000, due: "2026-11-15", label: "Season dues" } });
    await runPlanner(new Date("2026-12-06T23:05:00Z")); // availability for Tue Dec 8 (no weekly that Sunday)
    await runPlanner(new Date("2026-11-10T14:05:00Z")); // dues 5 days before Nov 15
    expect(ids("jo@example.com").length).toBe(2);
    // Jo answers Tuesday's practice in the app (not from the email), and pays dues.
    expect((await call("PUT", `/teams/${T}/family/p1`, "u-jo", { rsvp: { "pr1-2026-12-08": "yes" } }, "jo@example.com")).status).toBe(200);
    // Answering a different date doesn't count; nor does answering twice.
    expect((await call("PUT", `/teams/${T}/family/p1`, "u-jo", { rsvp: { "pr1-2026-12-08": "no" } }, "jo@example.com")).status).toBe(200);
    expect((await owner("PUT", `/teams/${T}/ledger/l1`, { kind: "in", cat: "Dues", pid: "p1", amountCents: 30000, date: "2026-11-11", desc: "Dues" })).status).toBe(200);
    // Travel plans for the tournament a packet asked about (the packet's own send is tested in reminders.test.ts).
    await put({ ...settings, features: { ...(settings.features ?? {}), fund: true, travel: true }, dues: { amountCents: 30000, due: "2026-11-15", label: "Season dues" } });
    await startFollow(T, "packet", "p2", ["t1"]);
    await put({ ...keys.event(T, "t1"), type: "Event", eid: "t1", kind: "tournament", title: "Fall Classic", date: "2026-12-12", travel: true });
    await put({ ...keys.event(T, "t9"), type: "Event", eid: "t9", kind: "tournament", title: "Other", date: "2026-12-19", travel: true });
    expect((await call("PUT", `/teams/${T}/family/p2`, "u-el", { travel: { t9: { mode: "Driving" } } }, "el@example.com")).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/family/p2`, "u-el", { travel: { t1: { mode: "Driving" } } }, "el@example.com")).status).toBe(200);
    const h = await health();
    expect(h.messages.find((m: any) => m.id === "packet")).toMatchObject({ next: 1, nextLabel: "added travel plans", sent: 0 });
    expect(h.messages.find((m: any) => m.id === "availability")).toMatchObject({ next: 1, nextLabel: "answered" });
    expect(h.messages.find((m: any) => m.id === "dues")).toMatchObject({ next: 1, nextLabel: "paid" });
  });

  it("goes when the team is deleted", async () => {
    await purgeTeam(T, "hc", OWNER);
    const left = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `MAILSTATS#${T}` } }));
    expect(left.Items).toEqual([]);
  });
});

describe("typo suggestions", () => {
  it("knows the common misspellings, and leaves real domains alone", () => {
    expect(suggestDomain("a@gmial.com")).toBe("gmail.com");
    expect(suggestDomain("a@Hotmial.com")).toBe("hotmail.com");
    expect(suggestDomain("a@gmail.com")).toBeUndefined();
    expect(suggestDomain("a@example.org")).toBeUndefined();
  });
});
