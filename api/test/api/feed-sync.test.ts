import { beforeAll, beforeEach, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-feed-sync";

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
    else lines.push(`DTSTART;TZID=America/New_York:${compact(e.date)}T${e.start}00`, `DTEND;TZID=America/New_York:${compact(e.date)}T${e.end}00`,
      "LOCATION:Northside Fieldhouse \\n200 Example Pkwy\\, Springfield\\, GA 30000");
    if (e.court) lines.push(`DESCRIPTION:Court: Court ${e.court}`);
    if (e.status) lines.push(`STATUS:${e.status}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// Saturday practices: the one before today (or today), and the next three.
const sat = (() => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1); return iso(d); })();
const plusDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const SATS = [0, 7, 14, 21].map((n) => plusDays(sat, n));
let feed: Ev[] = [];
const baseFeed = (): Ev[] => [
  ...SATS.map((d, i) => ({ uid: `SprocketSports-${100 + i}`, title: "14-1 Gold - Practice", date: d, start: "0730", end: "1000", court: String(i + 1) })),
  { uid: "SprocketSports-200", title: "14-1 Gold - Winter Showcase", date: day(40), allDayEnd: day(42) },
  { uid: "SprocketSports-300", title: "14-1 Gold - Media Day", date: day(10), start: "1000", end: "1200" },
  { uid: "SprocketSports-900", title: "General Skills Clinic", date: day(3), start: "1800", end: "1930" }
];

const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { forgetFeedKey } = await import("../../src/lib/feed/secret.js");
const { normalizeFeedUrl, setFeedFetcher } = await import("../../src/lib/feed/fetch.js");
const { eidFor, runFeedSync, changeText } = await import("../../src/lib/feed/sync.js");
const { buildItems } = await import("../../src/lib/comms/schedule.js");
const { PutCommand, GetCommand, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
setFeedFetcher(async (raw) => ({ body: ics(feed), host: normalizeFeedUrl(raw).hostname, finalHost: normalizeFeedUrl(raw).hostname }));

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COORD = "u-coord", COACH = "u-coach", PARENT = "u-par";
const T = "fs14";
const LINK = "https://cal.example.com/api/calendar/feed/0123456789abcdef0123456789abcdef.ics";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const coord = (m: string, p: string, b?: unknown) => call(m, p, COORD, b, "coord@example.com");
const coach = (m: string, p: string, b?: unknown) => call(m, p, COACH, b, "coach@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const get = async (k: { PK: string; SK: string }) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: k }))).Item;
const member = (sub: string, roles: string[], pid = "") => put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles, pid });
const ev = (uid: string) => get(keys.event(T, eidFor(uid)));
const resetManual = () => ddb.send(new UpdateCommand({ TableName: TABLE, Key: keys.feedSource(T), UpdateExpression: "REMOVE manualAt" }));
const syncNow = async () => { await resetManual(); return coord("POST", `/teams/${T}/feed/sync`); };
const HAND = "hand1";

beforeAll(async () => {
  await freshTable();
  forgetFeedKey();
  feed = baseFeed();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "fs", name: "Sync Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "fs", teamId: T, name: "Sync 14" })).status).toBe(201);
  await member(COORD, ["coordinator"]); await member(COACH, ["coach"]); await member(PARENT, ["parent"], "p1");
  await put({ ...keys.player(T, "p1"), type: "Player", first: "Ava", last: "Stone" });
  // A hand-entered weekly Saturday practice from four weeks back, with an answer and attendance on this Saturday.
  await put({ ...keys.event(T, HAND), type: "Event", kind: "practice", title: "Practice", date: plusDays(sat, -28), time: "7:30 AM", endTime: "10:00 AM",
    repeat: { every: 1, days: [6], until: plusDays(sat, 120), skipTournaments: true }, cancelled: [plusDays(sat, 14)] });
  await put({ ...keys.family(T, "p1"), type: "Family", rsvp: { [`${HAND}-${SATS[1]}`]: { v: "no", at: "x" }, [`${HAND}-${plusDays(sat, -7)}`]: { v: "yes", at: "x" } } });
  await put({ ...keys.attendance(T, `${HAND}-${sat}`), type: "Attendance", key: `${HAND}-${sat}`, date: sat, marks: { p1: { s: "late" } } });
  // Connect the feed (stage C1).
  const rules = (await coord("POST", `/teams/${T}/feed/check`, { url: LINK })).body.rules;
  expect((await coord("PUT", `/teams/${T}/feed`, { url: LINK, rules })).status).toBe(200);
});
beforeEach(() => { feed = feed.length ? feed : baseFeed(); });

describe("importing", () => {
  it("needs schedule rights and a saved feed, and can't start before it replaces", async () => {
    expect((await coach("POST", `/teams/${T}/feed/import`, { from: sat })).status).toBe(403);
    expect((await coord("POST", `/teams/${T}/feed/import`, { from: sat, replaceFrom: plusDays(sat, -1) })).status).toBe(400);
    expect((await coord("POST", `/teams/${T}/feed/sync`)).body.error).toBe("feed_not_imported");
  });

  it("puts the team's events on the schedule and hands-entered practices over to them", async () => {
    const r = await coord("POST", `/teams/${T}/feed/import`, { from: sat, replaceFrom: sat });
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ ok: true, trigger: "import", added: 6, changed: 0, total: 6 });
    expect(r.body.replaced).toEqual({ practicesRemoved: 0, seriesEnded: 1, answersMoved: 1, attendanceMoved: 1 });
    expect(r.body.feed.source).toMatchObject({ importFrom: sat, importedAt: expect.any(String), lastSync: { ok: true, added: 6 } });

    const p0 = await ev("SprocketSports-100");
    expect(p0).toMatchObject({ kind: "practice", title: "Practice", date: sat, time: "7:30 AM", endTime: "10:00 AM", location: "Northside Fieldhouse", address: "200 Example Pkwy, Springfield, GA 30000", court: "Court 1", src: { uid: "SprocketSports-100", rulesV: 1 } });
    expect(await ev("SprocketSports-200")).toMatchObject({ kind: "tournament", title: "Winter Showcase", date: day(40), endDate: day(41) });
    expect(await ev("SprocketSports-300")).toMatchObject({ kind: "event", title: "Media Day" });
    expect(await ev("SprocketSports-900")).toBeUndefined();

    // The hand-entered series now ends the day before, and keeps only its earlier cancelled dates.
    const hand = (await get(keys.event(T, HAND)))!;
    expect(hand.repeat.until).toBe(plusDays(sat, -1));
    expect(hand.cancelled).toEqual([]);
    // This Saturday's attendance and next Saturday's answer moved to the feed's practices; last week's answer stayed.
    const rsvp = (await get(keys.family(T, "p1")))!.rsvp;
    expect(Object.keys(rsvp).sort()).toEqual([`${HAND}-${plusDays(sat, -7)}`, eidFor("SprocketSports-101")].sort());
    expect(rsvp[eidFor("SprocketSports-101")].v).toBe("no");
    expect(await get(keys.attendance(T, `${HAND}-${sat}`))).toBeUndefined();
    expect(await get(keys.attendance(T, eidFor("SprocketSports-100")))).toMatchObject({ key: eidFor("SprocketSports-100"), marks: { p1: { s: "late" } } });

    expect((await coord("POST", `/teams/${T}/feed/import`, { from: sat })).body.error).toBe("feed_imported");
  });
});

describe("syncing", () => {
  it("writes nothing when nothing changed", async () => {
    const before = (await ev("SprocketSports-101"))!.updatedAt;
    const r = await syncNow();
    expect(r.body.run).toMatchObject({ ok: true, trigger: "manual", added: 0, changed: 0, unchanged: 6, missing: 0 });
    expect((await ev("SprocketSports-101"))!.updatedAt).toBe(before);
  });

  it("updates the feed's fields, keeps the team's, and records the change", async () => {
    // The team adds its own details; the feed's fields can't be changed while it syncs.
    const e = (await ev("SprocketSports-101"))!;
    const { PK: _p, SK: _s, GSI2PK: _g, GSI2SK: _g2, type: _t, updatedAt: _u, updatedBy: _b, src: _src, ...fields } = e;
    expect((await coach("PUT", `/teams/${T}/events/${eidFor("SprocketSports-101")}`, { ...fields, time: "9:00 AM", court: "Court 12", uniformColor: "Navy", notes: "Serve receive" })).status).toBe(200);
    expect(await ev("SprocketSports-101")).toMatchObject({ time: "7:30 AM", court: "Court 2", uniformColor: "Navy", notes: "Serve receive", src: { uid: "SprocketSports-101" } });

    feed[1] = { ...feed[1], start: "0800", end: "1030", court: "9" };
    const r = await syncNow();
    expect(r.body.run).toMatchObject({ ok: true, changed: 1, unchanged: 5 });
    expect(r.body.run.changes[0].text).toBe("now 8:00 AM (was 7:30 AM); now Court 9 (was Court 2)");
    expect(await ev("SprocketSports-101")).toMatchObject({ time: "8:00 AM", endTime: "10:30 AM", court: "Court 9", uniformColor: "Navy", notes: "Serve receive", src: { change: { text: expect.stringContaining("8:00 AM") } } });
    // The family's answer is still there.
    expect((await get(keys.family(T, "p1")))!.rsvp[eidFor("SprocketSports-101")].v).toBe("no");
    const chg = (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${T}`, ":s": "FEED#CHG#" } }))).Items!;
    expect(chg).toHaveLength(1);
    expect(chg[0]).toMatchObject({ eid: eidFor("SprocketSports-101"), reason: "feed", fields: { time: { was: "7:30 AM", now: "8:00 AM" } } });
    expect(r.body.feed.runs[0]).toMatchObject({ trigger: "manual", changed: 1 });
  });

  it("remembers a type an admin picked", async () => {
    const e = (await ev("SprocketSports-300"))!;
    const { PK: _p, SK: _s, GSI2PK: _g, GSI2SK: _g2, type: _t, updatedAt: _u, updatedBy: _b, src: _src, ...fields } = e;
    await coord("PUT", `/teams/${T}/events/${e.SK.slice(6)}`, { ...fields, kind: "deadline" });
    expect(await ev("SprocketSports-300")).toMatchObject({ kind: "deadline", src: { kindSet: true } });
    feed[5] = { ...feed[5], start: "1100", end: "1300" };
    await syncNow();
    expect(await ev("SprocketSports-300")).toMatchObject({ kind: "deadline", time: "11:00 AM" });
  });

  it("marks feed cancellations, and counts events gone from the feed without removing them", async () => {
    feed[2] = { ...feed[2], status: "CANCELLED" };
    const gone = feed.splice(3, 1)[0];
    let r = await syncNow();
    expect(r.body.run).toMatchObject({ changed: 1, missing: 1 });
    expect(r.body.run.changes[0].text).toBe("cancelled");
    const c = (await ev("SprocketSports-102"))!;
    expect(c.cancelled).toEqual([SATS[2]]);
    expect(buildItems([{ ...c, eid: "x" }], null)[0].cancelled).toBe(true);
    expect(await ev("SprocketSports-103")).toMatchObject({ src: { missing: 1, missingSince: expect.any(String) } });
    r = await syncNow();
    expect((await ev("SprocketSports-103"))!.src.missing).toBe(2);
    feed.splice(3, 0, gone);
    await syncNow();
    expect((await ev("SprocketSports-103"))!.src.missing).toBeUndefined();
  });

  it("can't delete or combine feed events while it syncs", async () => {
    expect((await coord("DELETE", `/teams/${T}/events/${eidFor("SprocketSports-103")}`)).body.error).toBe("feed_event");
    expect((await coord("POST", `/teams/${T}/events/combine`, { eids: [eidFor("SprocketSports-100"), eidFor("SprocketSports-101")], repeat: { every: 1, days: [6], until: day(60) } })).status).toBe(400);
  });

  it("limits Sync now to once every 5 minutes", async () => {
    await resetManual();
    expect((await coord("POST", `/teams/${T}/feed/sync`)).status).toBe(200);
    const r = await coord("POST", `/teams/${T}/feed/sync`);
    expect(r.status).toBe(429);
    expect(r.body.message).toMatch(/again in 5 minutes/);
  });

  it("records a failed read without touching the schedule", async () => {
    const saved = feed;
    setFeedFetcher(async () => ({ body: "<html>Down for maintenance</html>", host: "cal.example.com", finalHost: "cal.example.com" }));
    const r = await syncNow();
    expect(r.body.run).toMatchObject({ ok: false, code: "feed_not_calendar" });
    expect(r.body.feed.source).toMatchObject({ failures: 1, lastSync: { ok: false } });
    expect(await ev("SprocketSports-100")).toBeDefined();
    setFeedFetcher(async (raw) => ({ body: ics(saved), host: normalizeFeedUrl(raw).hostname, finalHost: normalizeFeedUrl(raw).hostname }));
    expect((await syncNow()).body.feed.source.failures).toBe(0);
  });
});

describe("the job and the switches", () => {
  it("syncs imported feeds whose team and club allow it", async () => {
    feed[0] = { ...feed[0], court: "7" };
    expect(await runFeedSync()).toEqual({ teams: 1, synced: 1, skipped: 0, failed: 0 });
    expect((await ev("SprocketSports-100"))!.court).toBe("Court 7");
    expect((await coord("PUT", `/teams/${T}/features`, { features: { calfeed: false } })).status).toBe(200);
    feed[0] = { ...feed[0], court: "8" };
    expect(await runFeedSync()).toEqual({ teams: 1, synced: 0, skipped: 1, failed: 0 });
    expect((await ev("SprocketSports-100"))!.court).toBe("Court 7");
    expect((await coord("POST", `/teams/${T}/feed/sync`)).status).toBe(409);
  });

  it("while it's off, admins can change the feed's fields and delete feed events", async () => {
    const e = (await ev("SprocketSports-100"))!;
    const { PK: _p, SK: _s, GSI2PK: _g, GSI2SK: _g2, type: _t, updatedAt: _u, updatedBy: _b, src: _src, ...fields } = e;
    await coord("PUT", `/teams/${T}/events/${e.SK.slice(6)}`, { ...fields, court: "Court 3" });
    expect(await ev("SprocketSports-100")).toMatchObject({ court: "Court 3", src: { uid: "SprocketSports-100" } });
    expect((await owner("PUT", "/admin/clubs/fs", { features: { calfeed: false } })).status).toBe(200);
    expect((await coord("PUT", `/teams/${T}/features`, { features: { calfeed: true } })).status).toBe(409); // the club has it off
    expect(await runFeedSync()).toMatchObject({ skipped: 1 });
    expect((await owner("PUT", "/admin/clubs/fs", { features: { calfeed: true } })).status).toBe(200);
    expect((await coord("PUT", `/teams/${T}/features`, { features: { calfeed: true } })).status).toBe(200);
    expect(await runFeedSync()).toMatchObject({ synced: 1 });
    expect((await ev("SprocketSports-100"))!.court).toBe("Court 8");
  });

  it("disconnecting keeps the events as the team's own", async () => {
    expect((await coord("DELETE", `/teams/${T}/feed`)).body).toEqual({ connected: false, eventsKept: 6 });
    const e = (await ev("SprocketSports-100"))!;
    expect(e.src).toBeUndefined();
    expect(e).toMatchObject({ title: "Practice", court: "Court 8" });
    expect(await runFeedSync()).toMatchObject({ teams: 0 });
  });
});

describe("change wording", () => {
  it("says what moved", () => {
    const base = { kind: "practice" as const, cancelled: false, title: "Practice", date: "2026-11-07", time: "7:30 AM", court: "Court 6", location: "A5 Sportsplex" };
    expect(changeText(base, { ...base, date: "2026-11-08" }, false)).toBe("moved to Sun, Nov 8 (was Sat, Nov 7)");
    expect(changeText(base, { ...base, location: "Riverside Gym", court: undefined }, false)).toBe("no court listed now; now at Riverside Gym");
    expect(changeText(base, { ...base, kind: "event" }, false)).toBe("now an event");
    expect(changeText(base, { ...base, kind: "event" }, true)).toBe("");
    expect(changeText({ ...base, cancelled: true }, base, false)).toBe("back on");
  });
});
