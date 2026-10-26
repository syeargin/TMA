import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-feed-quiet";

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
const { eidFor, runFeedSync } = await import("../../src/lib/feed/sync.js");
const { purgeTeam } = await import("../../src/lib/retention.js");
const { PutCommand, GetCommand, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
// The calendar site: answers "not modified" when it's sent the ETag it gave out, like a well-behaved server.
let etagSupport = false;
const fetches: { conditional: boolean }[] = [];
setFeedFetcher(async (raw, last) => {
  const host = normalizeFeedUrl(raw).hostname, body = ics(feed), etag = `"${body.length}-${feed.map((e) => e.start ?? "").join("")}"`;
  fetches.push({ conditional: !!last?.etag });
  if (etagSupport && last?.etag === etag) return { body: "", host, finalHost: host, notModified: true, etag };
  return { body, host, finalHost: host, ...(etagSupport ? { etag } : {}) };
});

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COORD = "u-coord", COACH = "u-coach", PARENT = "u-par";
const T = "fq14";
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

const q = async (pk: string, prefix: string) => (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": pk, ":s": prefix } }))).Items ?? [];
const source = () => get(keys.feedSource(T));

beforeAll(async () => {
  await freshTable();
  forgetFeedKey();
  feed = baseFeed();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "fq", name: "Quiet Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "fq", teamId: T, name: "Quiet 14" })).status).toBe(201);
  await member(COORD, ["coordinator"]);
  // Logs written the C3 way, in the team's own data: they move out on the first sync.
  await put({ PK: `TEAM#${T}`, SK: "FEED#SYNC#2026-10-25T10:00:00.000Z", type: "FeedSync", ok: true, added: 0, changed: 0 });
  await put({ PK: `TEAM#${T}`, SK: "FEED#CHG#2026-10-25T10:00:00.000Z#fdx", type: "FeedChange", eid: "fdx", text: "now 8:00 AM" });
  const rules = (await coord("POST", `/teams/${T}/feed/check`, { url: LINK })).body.rules;
  expect((await coord("PUT", `/teams/${T}/feed`, { url: LINK, rules })).status).toBe(200);
  expect((await coord("POST", `/teams/${T}/feed/import`, { from: sat })).body.run).toMatchObject({ ok: true, added: 6 });
});

describe("sync logs", () => {
  it("live outside the team's data, so loading the team never reads them", async () => {
    expect(await q(`TEAM#${T}`, "FEED#SYNC#")).toEqual([]);
    expect(await q(`TEAM#${T}`, "FEED#CHG#")).toEqual([]);
    expect((await q(`FEEDLOG#${T}`, "CHG#")).map((r) => r.eid)).toEqual(["fdx"]);
    expect((await q(`FEEDLOG#${T}`, "SYNC#")).length).toBe(2); // the old one and the import
    expect((await source())!.logsMoved).toBe(true);
  });

  it("aren't written for quiet runs of the job, which don't read the schedule either", async () => {
    const before = (await q(`FEEDLOG#${T}`, "SYNC#")).length;
    const r = await runFeedSync({ due: false });
    expect(r).toMatchObject({ synced: 1 });
    expect((await q(`FEEDLOG#${T}`, "SYNC#")).length).toBe(before);
    const s = (await source())!;
    expect(s.lastSync).toMatchObject({ ok: true, trigger: "job", unchanged: 6, total: 6 });
    expect(s.soon.length).toBeGreaterThan(3);
    // A change is kept, and so is Sync now.
    feed[1] = { ...feed[1], start: "0800", end: "1030" };
    await runFeedSync({ due: false });
    expect((await q(`FEEDLOG#${T}`, "SYNC#")).length).toBe(before + 1);
    expect((await q(`FEEDLOG#${T}`, "CHG#")).length).toBe(2);
    await syncNow();
    expect((await q(`FEEDLOG#${T}`, "SYNC#")).length).toBe(before + 2);
  });
});

describe("asking the calendar site", () => {
  it("sends its ETag back, and a 'not modified' answer is a quiet run", async () => {
    etagSupport = true;
    await syncNow(); // a full sync picks up the ETag
    expect((await source())!.etag).toMatch(/^"/);
    fetches.length = 0;
    expect(await runFeedSync({ due: false })).toMatchObject({ synced: 1 });
    expect(fetches).toEqual([{ conditional: true }]);
    expect((await source())!.lastSync).toMatchObject({ ok: true, changed: 0 });
    feed[1] = { ...feed[1], start: "0900", end: "1100" };
    await runFeedSync({ due: false });
    expect((await source())!.lastSync).toMatchObject({ ok: true, changed: 1 });
    etagSupport = false;
  });

  it("only when it's due, and the panel says when that is", async () => {
    // Just synced: not due again until its next slot.
    expect(await runFeedSync()).toMatchObject({ synced: 0, notDue: 1 });
    const v = (await coord("GET", `/teams/${T}/feed`)).body.source;
    expect(v.everyMinutes === 30 || v.everyMinutes === 120).toBe(true);
    expect(Date.parse(v.nextSyncAt)).toBeGreaterThan(Date.now());
  });
});

describe("deleting the team", () => {
  it("takes the feed log with it", async () => {
    await purgeTeam(T, "fq", "test");
    expect((await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `FEEDLOG#${T}` } }))).Items).toEqual([]);
  });
});
