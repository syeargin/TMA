import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-feed-review";

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
const { eidFor, runFeedSync, needsAttention } = await import("../../src/lib/feed/sync.js");
const { PutCommand, GetCommand, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
setFeedFetcher(async (raw) => ({ body: ics(feed), host: normalizeFeedUrl(raw).hostname, finalHost: normalizeFeedUrl(raw).hostname }));

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COORD = "u-coord", COACH = "u-coach", PARENT = "u-par";
const T = "fr14";
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
  expect((await owner("POST", "/clubs", { clubId: "fr", name: "Review Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "fr", teamId: T, name: "Review 14" })).status).toBe(201);
  await member(COORD, ["coordinator"]); await member(COACH, ["coach"]); await member(PARENT, ["parent"], "p1");
  await put({ ...keys.player(T, "p1"), type: "Player", first: "Ava", last: "Stone" });
  const rules = (await coord("POST", `/teams/${T}/feed/check`, { url: LINK })).body.rules;
  expect((await coord("PUT", `/teams/${T}/feed`, { url: LINK, rules })).status).toBe(200);
  expect((await coord("POST", `/teams/${T}/feed/import`, { from: sat })).body.run).toMatchObject({ ok: true, added: 6 });
});
const view = async () => (await coord("GET", `/teams/${T}/feed`)).body;
const review = async (b: Record<string, unknown>) => coord("POST", `/teams/${T}/feed/review`, b);
const P1 = () => eidFor("SprocketSports-101");

describe("overrides", () => {
  it("keep the team's value, and flag it when the calendar changes that field", async () => {
    expect((await coach("PUT", `/teams/${T}/events/${P1()}/override`, { ov: { court: "Court 6" } })).status).toBe(200);
    expect(await ev("SprocketSports-101")).toMatchObject({ court: "Court 6", src: { ov: { court: "Court 6" }, ovBase: { court: "Court 2" } } });
    // The calendar changes the time (not overridden) and the court (overridden).
    feed[1] = { ...feed[1], start: "0800", end: "1030", court: "9" };
    await syncNow();
    expect(await ev("SprocketSports-101")).toMatchObject({ time: "8:00 AM", court: "Court 6", src: { conflict: { court: "Court 9" } } });
    expect((await view()).review).toEqual([expect.objectContaining({ kind: "conflict", eid: P1(), field: "court", mine: "Court 6", feed: "Court 9" })]);
    // Keep mine: the conflict goes, and only a further calendar change brings it back.
    await review({ action: "keepMine", eid: P1(), field: "court" });
    expect((await ev("SprocketSports-101"))!.src).toMatchObject({ ov: { court: "Court 6" }, ovBase: { court: "Court 9" } });
    expect((await ev("SprocketSports-101"))!.src.conflict).toBeUndefined();
    await syncNow();
    expect((await view()).review).toEqual([]);
    feed[1] = { ...feed[1], court: "10" };
    await syncNow();
    // Use the calendar's: the override goes and the calendar's value comes back.
    expect((await review({ action: "useFeed", eid: P1(), field: "court" })).status).toBe(200);
    const e = (await ev("SprocketSports-101"))!;
    expect(e.court).toBe("Court 10");
    expect(e.src.ov).toBeUndefined();
    const h = (await coord("GET", `/teams/${T}/events/${P1()}/history`)).body.history;
    expect(h.map((x: any) => x.reason)).toEqual(["override", "feed", "override", "feed", "override"]);
    expect(h[0].text).toBe("court back to the calendar's (Court 10)");
  });

  it("need the feature on and schedule rights", async () => {
    expect((await call("PUT", `/teams/${T}/events/${P1()}/override`, PARENT, { ov: { court: "Court 1" } })).status).toBe(403);
    expect((await coach("PUT", `/teams/${T}/events/${P1()}/override`, { ov: { title: "Scrimmage" } })).status).toBe(400);
  });
});

describe("events gone from the calendar", () => {
  it("go on the review list after two syncs; cancelling stops the counting and a return undoes it", async () => {
    const gone = feed.splice(2, 1)[0];
    await syncNow();
    expect((await view()).review).toEqual([]);
    await syncNow();
    expect((await view()).review).toEqual([expect.objectContaining({ kind: "missing", eid: eidFor("SprocketSports-102"), syncs: 2 })]);
    await review({ action: "cancel", eid: eidFor("SprocketSports-102") });
    expect(await ev("SprocketSports-102")).toMatchObject({ cancelled: [SATS[2]], src: { gone: true, change: { text: "cancelled" } } });
    await syncNow();
    expect((await ev("SprocketSports-102"))!.src.missing).toBeUndefined();
    expect((await view()).review).toEqual([]);
    feed.splice(2, 0, gone);
    const r = await syncNow();
    expect(r.body.run.changes).toEqual([expect.objectContaining({ text: "back on" })]);
    const back = (await ev("SprocketSports-102"))!;
    expect(back.cancelled).toBeUndefined();
    expect(back.src.gone).toBeUndefined();
  });

  it("can be kept instead", async () => {
    const gone = feed.splice(3, 1)[0];
    await syncNow(); await syncNow();
    await review({ action: "keep", eid: eidFor("SprocketSports-103") });
    expect(await ev("SprocketSports-103")).toMatchObject({ src: { keep: true } });
    expect((await ev("SprocketSports-103"))!.cancelled).toBeUndefined();
    await syncNow();
    expect((await view()).review).toEqual([]);
    feed.splice(3, 0, gone);
    await syncNow();
    expect((await ev("SprocketSports-103"))!.src.keep).toBeUndefined();
  });
});

describe("possible duplicates", () => {
  it("are offered when an event comes back under a new id, and merging keeps the old one's answers", async () => {
    await put({ ...keys.family(T, "p1"), type: "Family", rsvp: { [eidFor("SprocketSports-101")]: { v: "yes", at: "x" } } });
    feed[1] = { ...feed[1], uid: "SprocketSports-555" };
    await syncNow();
    const dup = eidFor("SprocketSports-555"), old = eidFor("SprocketSports-101");
    expect((await view()).review).toEqual([expect.objectContaining({ kind: "duplicate", eid: dup, of: old })]);
    await review({ action: "merge", eid: dup });
    expect(await get(keys.event(T, dup))).toBeUndefined();
    expect((await get(keys.event(T, old)))!.src).toMatchObject({ uid: "SprocketSports-555" });
    expect((await get(keys.event(T, old)))!.src.missing).toBeUndefined();
    expect((await get(keys.family(T, "p1")))!.rsvp[old].v).toBe("yes");
    expect((await syncNow()).body.run).toMatchObject({ added: 0, missing: 0 });
    expect((await view()).review).toEqual([]);
  });

  it("can be told apart", async () => {
    feed.push({ ...feed[5], uid: "SprocketSports-777" });
    feed.splice(5, 1);
    await syncNow();
    const dup = eidFor("SprocketSports-777");
    expect((await view()).review.map((x: any) => x.kind)).toEqual(["duplicate"]);
    await review({ action: "different", eid: dup });
    expect((await ev("SprocketSports-777"))!.src.dupOf).toBeUndefined();
    feed.splice(5, 0, { ...feed.pop()!, uid: "SprocketSports-300" });
    feed.push({ ...feed[5], uid: "SprocketSports-777" });
  });
});

describe("when the rules stop matching", () => {
  it("pauses instead of putting every event up for removal", async () => {
    expect(needsAttention(6, 2)).toBe(true);
    expect(needsAttention(6, 4)).toBe(false);
    expect(needsAttention(3, 0)).toBe(false);
    const saved = feed;
    feed = feed.map((e) => e.title.startsWith("14-1 Gold - ") ? { ...e, title: e.title.replace("14-1 Gold - ", "14U Gold | ") } : e);
    const r = await syncNow();
    expect(r.body.run).toMatchObject({ ok: false, code: "feed_attention", total: 0 });
    expect(r.body.feed.source.attention).toMatchObject({ was: expect.any(Number), now: 0 });
    expect((await ev("SprocketSports-101"))!.src.missing).toBeUndefined();
    expect((await coord("GET", `/teams/${T}`)).body.feedStatus).toMatchObject({ attention: true });
    expect((await call("GET", `/teams/${T}`, PARENT)).body.feedStatus).toBeUndefined();
    // New rules for the new titles: the next sync applies them.
    const rules = (await view()).rules;
    await coord("PUT", `/teams/${T}/feed`, { rules: { ...rules, filter: { mode: "prefix", text: "14U Gold |" } } });
    const r2 = await syncNow();
    expect(r2.body.run).toMatchObject({ ok: true, total: saved.length - 1 }); // the clinic isn't the team's
    expect(r2.body.feed.source.attention).toBeNull();
    expect((await ev("SprocketSports-101"))!.title).toBe("Practice");
    feed = saved;
    await coord("PUT", `/teams/${T}/feed`, { rules });
    await syncNow();
  });

  it("an admin can say the drop is right", async () => {
    const saved = feed;
    feed = feed.slice(0, 1);
    expect((await syncNow()).body.run.code).toBe("feed_attention");
    const r = await coord("POST", `/teams/${T}/feed/attention/accept`);
    expect(r.body.run).toMatchObject({ ok: true, total: 1 });
    expect(r.body.run.missing).toBeGreaterThan(3);
    feed = saved;
    await syncNow();
    expect((await syncNow()).body.run).toMatchObject({ ok: true, missing: 0 });
  });
});

describe("turning it off and back on", () => {
  it("keeps edits made while off as overrides, and asks for a catch-up before syncing again", async () => {
    expect((await coord("PUT", `/teams/${T}/features`, { features: { calfeed: false } })).status).toBe(200);
    expect((await view()).source.pausedSince).toEqual(expect.any(String));
    const e = (await ev("SprocketSports-102"))!;
    const { PK: _p, SK: _s, GSI2PK: _g, GSI2SK: _g2, type: _t, updatedAt: _u, updatedBy: _b, src: _src, ...fields } = e;
    await coord("PUT", `/teams/${T}/events/${e.SK.slice(6)}`, { ...fields, court: "Aux gym", title: "Renamed" });
    expect(await ev("SprocketSports-102")).toMatchObject({ court: "Aux gym", src: { ov: { court: "Aux gym" }, ovBase: { court: "Court 3" } } });
    feed[0] = { ...feed[0], start: "0900", end: "1100" };
    expect((await coord("PUT", `/teams/${T}/features`, { features: { calfeed: true } })).status).toBe(200);
    // Back on: nothing syncs until an admin has looked.
    expect(await runFeedSync()).toMatchObject({ synced: 0, skipped: 1 });
    expect((await get(keys.event(T, eidFor("SprocketSports-100"))))!.time).toBe("7:30 AM");
    expect((await syncNow()).body.error).toBe("feed_catchup");
    const pre = (await coord("POST", `/teams/${T}/feed/catchup`)).body.feed.source.catchUp;
    expect(pre.changes.map((c: any) => c.text).sort()).toEqual(["now 9:00 AM (was 7:30 AM)", 'renamed "Practice"']);
    const r = await coord("POST", `/teams/${T}/feed/catchup/apply`);
    expect(r.body.run).toMatchObject({ ok: true, changed: 2 });
    expect(r.body.feed.source).toMatchObject({ pausedSince: null, catchUp: null });
    expect((await get(keys.event(T, eidFor("SprocketSports-100"))))!.time).toBe("9:00 AM");
    expect(await ev("SprocketSports-102")).toMatchObject({ title: "Practice", court: "Aux gym" });
    expect(await runFeedSync()).toMatchObject({ synced: 1 });
  });
});

describe("club templates", () => {
  it("give a club's teams the club's rules for a calendar system", async () => {
    const rules = { ...(await view()).rules, types: [{ when: "title", text: "Practice", kind: "practice" }, { when: "title", text: "Media", kind: "event" }, { when: "allDay", kind: "tournament" }] };
    expect((await coord("PUT", "/clubs/fr/feed-templates/sprocket", { rules })).status).toBe(403);
    expect((await owner("PUT", "/clubs/fr/feed-templates/sprocket", { rules })).status).toBe(200);
    expect((await owner("POST", "/teams", { clubId: "fr", teamId: "fr15", name: "Review 15" })).status).toBe(201);
    await put({ ...keys.member("fr15", COORD), ...keys.memberGsi("fr15", COORD), type: "Membership", status: "active", sub: COORD, roles: ["coordinator"] });
    const c = (await coord("POST", "/teams/fr15/feed/check", { url: LINK })).body;
    expect(c.template).toMatchObject({ used: true });
    expect(c.rules).toMatchObject({ filter: { mode: "prefix", text: "14-1 Gold -" }, types: rules.types, preset: "sprocket" });
    expect(c.rules.filterMode).toBeUndefined();
    expect((await owner("DELETE", "/clubs/fr/feed-templates/sprocket")).status).toBe(204);
    expect((await coord("POST", "/teams/fr15/feed/check", { url: LINK })).body.template).toBeNull();
  });
});
