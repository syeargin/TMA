import { beforeAll, beforeEach, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-feed-notices";
process.env.MAIL_TRANSPORT = "memory";

// A made-up club calendar, built around today so the test reads the same on any day.
type Ev = { uid: string; title: string; date: string; start?: string; end?: string; court?: string; allDayEnd?: string; status?: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (n: number) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const compact = (s: string) => s.replace(/-/g, "");
function ics(events: Ev[]) {
  const lines = ["BEGIN:VCALENDAR", "PRODID:-//github.com/rianjs/ical.net//NONSGML ical.net 5.2.2//EN", "X-WR-CALNAME:My Calendar"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, "DTSTAMP:20261025T120000Z", `SUMMARY:${e.title}`);
    if (e.allDayEnd) lines.push(`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(e.allDayEnd)}`);
    else lines.push(`DTSTART:${compact(e.date)}T${e.start}00`, `DTEND:${compact(e.date)}T${e.end}00`,
      "LOCATION:Northside Fieldhouse \\n200 Example Pkwy\\, Springfield\\, GA 30000");
    if (e.court) lines.push(`DESCRIPTION:Court: Court ${e.court}`);
    if (e.status) lines.push(`STATUS:${e.status}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// The made-up club calendar: practices a few days out, and one three weeks out.
const PRACTICES = [3, 5, 21].map((n, i) => ({ uid: `SprocketSports-${100 + i}`, title: "14-1 Gold - Practice", date: day(n), start: "1800", end: "2000", court: "4" }));
let feed: Ev[] = [];
const baseFeed = (): Ev[] => [...PRACTICES.map((p) => ({ ...p })), { uid: "SprocketSports-200", title: "14-1 Gold - Media Day", date: day(8), start: "1000", end: "1200" },
  ...[10, 12].map((n, i) => ({ uid: `SprocketSports-${300 + i}`, title: "14-1 Gold - Practice", date: day(n), start: "1800", end: "2000", court: "2" }))];

const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { forgetFeedKey } = await import("../../src/lib/feed/secret.js");
const { normalizeFeedUrl, setFeedFetcher } = await import("../../src/lib/feed/fetch.js");
const { eidFor, runFeedSync, FAILING_AFTER } = await import("../../src/lib/feed/sync.js");
const { flushHeld } = await import("../../src/lib/comms/feed-notices.js");
const { commsKey } = await import("../../src/lib/comms/planner.js");
const { loadTeam, staffContent, weeklyContent } = await import("../../src/lib/comms/content.js");
const { memoryOutbox } = await import("../../src/lib/mail/outbox.js");
const { PutCommand, GetCommand, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
let broken = false;
setFeedFetcher(async (raw) => {
  if (broken) return { body: "<html>Down</html>", host: "cal.example.com", finalHost: "cal.example.com" };
  return { body: ics(feed), host: normalizeFeedUrl(raw).hostname, finalHost: normalizeFeedUrl(raw).hostname };
});

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COORD = "u-coord", COACH = "u-coach", PARENT = "u-par", ADMIN = "u-admin";
const T = "fn14";
const LINK = "https://cal.example.com/api/calendar/feed/0123456789abcdef0123456789abcdef.ics";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const coord = (m: string, p: string, b?: unknown) => call(m, p, COORD, b, "coord@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const get = async (k: { PK: string; SK: string }) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: k }))).Item;
const member = (sub: string, roles: string[], email: string, pid = "") => put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles, pid, email, firstName: sub.slice(2) });
const resetManual = () => ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.feedSource(T), UpdateExpression: "REMOVE manualAt" }));
const syncNow = async () => { await resetManual(); return coord("POST", `/teams/${T}/feed/sync`); };
const to = (msg: string) => memoryOutbox.filter((m) => m.tags.msg === msg || m.subject.includes(msg)).map((m) => m.to).sort();
const mails = () => memoryOutbox.map((m) => ({ to: m.to, subject: m.subject }));

/** A time zone where it's now `hour` o'clock, so the overnight hold is predictable whenever the test runs. */
function zoneAt(hour: number) {
  const n = new Date().getUTCHours() - hour;
  const w = ((n + 36) % 24) - 12; // -12..11
  return w === 0 ? "Etc/GMT" : `Etc/GMT${w > 0 ? "+" : "-"}${Math.abs(w)}`;
}
const setComms = (c: Record<string, unknown>) => put({ ...commsKey(T), type: "Comms", ...c });
const DAYTIME = zoneAt(12);

beforeAll(async () => {
  await freshTable();
  forgetFeedKey();
  feed = baseFeed();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "fn", name: "Notice Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "fn", teamId: T, name: "Notice 14" })).status).toBe(201);
  await member(COORD, ["coordinator"], "coord@example.com");
  await member(ADMIN, ["admin"], "admin@example.com");
  await member(COACH, ["coach"], "coach@example.com");
  await member(PARENT, ["parent"], "par@example.com", "p1");
  await put({ ...keys.player(T, "p1"), type: "Player", first: "Ava", last: "Stone" });
  await setComms({ timeZone: DAYTIME });
  const rules = (await coord("POST", `/teams/${T}/feed/check`, { url: LINK })).body.rules;
  // Every event here is the team's, so no filter is suggested; set the club's usual one.
  expect((await coord("PUT", `/teams/${T}/feed`, { url: LINK, rules: { ...rules, filter: { mode: "prefix", text: "14-1 Gold -" } } })).status).toBe(200);
  expect((await coord("POST", `/teams/${T}/feed/import`, { from: day(0) })).body.run).toMatchObject({ ok: true, added: 6 });
});
beforeEach(() => { memoryOutbox.length = 0; });

describe("cancelled or moved", () => {
  it("is off until the team turns it on", async () => {
    feed[0] = { ...feed[0], start: "1830", end: "2030" };
    expect((await syncNow()).body.run).toMatchObject({ changed: 1, emailed: 0 });
    expect(mails()).toEqual([]);
  });

  it("emails families and staff once per sync with every change coming up", async () => {
    await setComms({ timeZone: DAYTIME, messages: { change: { on: true } } });
    feed[0] = { ...feed[0], start: "1900", end: "2100" };
    feed[1] = { ...feed[1], status: "CANCELLED" };
    feed[2] = { ...feed[2], start: "0700", end: "0900" }; // three weeks out: no email
    const r = await syncNow();
    expect(r.body.run).toMatchObject({ changed: 3, emailed: 4 });
    expect(mails().map((m) => m.to).sort()).toEqual(["admin@example.com", "coach@example.com", "coord@example.com", "par@example.com"]);
    const m = memoryOutbox.find((x) => x.to === "par@example.com")!;
    expect(m.subject).toBe("Notice 14: 2 schedule changes");
    expect(m.text).toContain("Practice: now 7:00 PM (was 6:30 PM)");
    expect(m.text).toContain("Practice: cancelled");
    expect(m.text).not.toContain("7:00 AM");
    // Nothing changed: nothing sent.
    memoryOutbox.length = 0;
    expect((await syncNow()).body.run).toMatchObject({ changed: 0 });
    expect(mails()).toEqual([]);
  });

  it("leaves out renames, court-only changes when the team says so, and fields the team overrode", async () => {
    await setComms({ timeZone: DAYTIME, messages: { change: { on: true, rules: { court: false } } } });
    feed[0] = { ...feed[0], court: "9" };
    feed[3] = { ...feed[3], title: "14-1 Gold - Media and Photo Day" };
    expect((await syncNow()).body.run).toMatchObject({ changed: 2, emailed: 0 });
    await call("PUT", `/teams/${T}/events/${eidFor("SprocketSports-100")}/override`, COACH, { ov: { time: "6:45 PM" } });
    feed[0] = { ...feed[0], start: "1930" };
    memoryOutbox.length = 0;
    await syncNow();
    // The families' time stays the team's, so they hear nothing; the admins hear about the conflict.
    expect(memoryOutbox.filter((x) => x.subject.includes("schedule") || x.subject.includes("Changed"))).toEqual([]);
    expect(mails().map((x) => x.to).sort()).toEqual(["admin@example.com", "coord@example.com"]);
    expect(memoryOutbox[0].subject).toBe("Notice 14: 1 thing needs your review");
    expect(memoryOutbox[0].text).toContain("the calendar now has 7:30 PM; the team's override says 6:45 PM");
  });

  it("goes out when an admin cancels an event gone from the calendar", async () => {
    await setComms({ timeZone: DAYTIME, messages: { change: { on: true } } });
    const gone = feed.splice(3, 1)[0];
    await syncNow();
    expect(mails()).toEqual([]);
    await syncNow();
    // Two syncs missing: the admins are asked to review it, once.
    expect(mails().map((x) => x.to).sort()).toEqual(["admin@example.com", "coord@example.com"]);
    expect(memoryOutbox[0].text).toContain("not on the club's calendar any more");
    memoryOutbox.length = 0;
    await syncNow();
    expect(mails()).toEqual([]);
    await coord("POST", `/teams/${T}/feed/review`, { action: "cancel", eid: eidFor("SprocketSports-200") });
    expect(memoryOutbox.find((x) => x.to === "par@example.com")!.subject).toMatch(/^Notice 14: Cancelled: Media and Photo Day, /);
    feed.splice(3, 0, gone);
  });
});

describe("overnight", () => {
  it("holds what it finds and sends it in the morning, as one email", async () => {
    await call("PUT", `/teams/${T}/events/${eidFor("SprocketSports-100")}/override`, COACH, { ov: { time: null } });
    await syncNow();
    memoryOutbox.length = 0;
    await setComms({ timeZone: zoneAt(2), messages: { change: { on: true } } });
    feed[0] = { ...feed[0], start: "1700", end: "1900" };
    expect((await syncNow()).body.run).toMatchObject({ emailed: 0 });
    feed[0] = { ...feed[0], start: "1600", end: "1800" };
    await syncNow();
    expect(mails()).toEqual([]);
    expect((await get(keys.feedSource(T)))!.noticesHeld).toBe(true);
    // Still night: nothing yet.
    expect(await flushHeld(T, "fn")).toBe(0);
    await setComms({ timeZone: DAYTIME, messages: { change: { on: true } } });
    expect(await runFeedSync({ due: false })).toMatchObject({ synced: 1 });
    const m = memoryOutbox.filter((x) => x.to === "par@example.com");
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain("now 4:00 PM (was 5:00 PM)");
    expect((await get(keys.feedSource(T)))!.noticesHeld).toBeUndefined();
  });
});

describe("feed alerts", () => {
  it("tell admins once when the feed can't be read for a while", async () => {
    broken = true;
    for (let i = 0; i < FAILING_AFTER + 2; i++) await syncNow();
    broken = false;
    expect(mails().map((x) => x.to).sort()).toEqual(["admin@example.com", "coord@example.com"]);
    expect(memoryOutbox[0].subject).toBe("Notice 14: The club's calendar can't be read");
    memoryOutbox.length = 0;
    await syncNow();
  });

  it("tell admins when syncing pauses because the rules stopped matching", async () => {
    const saved = feed;
    feed = feed.map((e) => ({ ...e, title: e.title.replace("14-1 Gold - ", "14U | ") }));
    await syncNow(); await syncNow();
    expect(memoryOutbox.filter((x) => x.subject.includes("paused")).map((x) => x.to).sort()).toEqual(["admin@example.com", "coord@example.com"]);
    feed = saved;
    await coord("POST", `/teams/${T}/feed/attention/accept`);
  });

  it("can be turned off", async () => {
    await setComms({ timeZone: DAYTIME, messages: { feedAlert: { on: false } } });
    broken = true;
    for (let i = 0; i < FAILING_AFTER + 1; i++) await syncNow();
    broken = false;
    expect(mails()).toEqual([]);
  });
});

describe("the weekly email and staff digest", () => {
  it("mark what the club's calendar changed", async () => {
    const t = await loadTeam(T, "fn");
    const par = t.members.find((m) => m.sub === PARENT)!, coach = t.members.find((m) => m.sub === COACH)!, admin = t.members.find((m) => m.sub === ADMIN)!;
    const w = weeklyContent(t, par, day(-1));
    expect(w.items.find((i) => i.changed)).toMatchObject({ title: "Practice", changed: expect.stringContaining("now") });
    const s = staffContent(t, coach, day(-1));
    expect(s.feed!.changes.length).toBeGreaterThan(0);
    expect(s.feed!.review).toBe(0);
    expect(staffContent(t, admin, day(-1)).feed).toBeTruthy();
  });
});
