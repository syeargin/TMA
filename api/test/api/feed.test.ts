import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-feed";

const LINK = "https://cal.example.com/api/calendar/feed/0123456789abcdef0123456789abcdef.ics";
const SECOND = "webcal://calendar.example.org/u/abcdefabcdefabcdef1234/team.ics";
const fixture = (name: string) => readFileSync(new URL(`../feed/fixtures/${name}`, import.meta.url), "utf8");
// The feed's site is replaced by the test calendars; everything else is real.
const fetched: string[] = [];

const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { forgetFeedKey, openLink } = await import("../../src/lib/feed/secret.js");
const { normalizeFeedUrl, setFeedFetcher } = await import("../../src/lib/feed/fetch.js");
const { FeedError } = await import("../../src/lib/feed/ical.js");
setFeedFetcher(async (raw) => {
  const u = normalizeFeedUrl(raw);
  fetched.push(u.toString());
  if (u.pathname.includes("gone")) throw new FeedError("feed_gone", "The calendar link didn't work.");
  return { body: fixture(u.hostname === "cal.example.com" ? "sprocket-style.ics" : "google-style.ics"), host: u.hostname, finalHost: u.hostname };
});
const { PutCommand, GetCommand, QueryCommand, DeleteCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COORD = "u-coord", COACH = "u-coach", PARENT = "u-par";
const T = "fd14";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const coord = (m: string, p: string, b?: unknown) => call(m, p, COORD, b, "coord@example.com");
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const member = (sub: string, roles: string[]) => put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles });
const feedItems = async () => (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${T}`, ":s": "FEED#" } }))).Items ?? [];

beforeAll(async () => {
  await freshTable();
  forgetFeedKey();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("POST", "/clubs", { clubId: "fc", name: "Feed Club" })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "fc", teamId: T, name: "Feed 14" })).status).toBe(201);
  await member(COORD, ["coordinator"]); await member(COACH, ["coach"]); await member(PARENT, ["parent"]);
});

// Each test starts with no recent checks (the limit has its own test).
beforeEach(async () => { await ddb.send(new DeleteCommand({ TableName: TABLE, Key: keys.feedChecks(T) })); });

describe("checking a feed", () => {
  it("is for team admins and coordinators", async () => {
    expect((await call("POST", `/teams/${T}/feed/check`, COACH, { url: LINK })).status).toBe(403);
    expect((await call("GET", `/teams/${T}/feed`, PARENT)).status).toBe(403);
    expect((await coord("GET", `/teams/${T}/feed`)).body).toEqual({ connected: false });
  });

  it("reads the calendar, detects the system and suggests rules, without saving anything", async () => {
    const r = await coord("POST", `/teams/${T}/feed/check`, { url: LINK });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      host: "cal.example.com", masked: "cal.example.com/…/feed/0123…abcdef.ics", preset: "sprocket", presetLabel: "Sprocket Sports",
      calendar: { name: "My Calendar", total: 22, from: "2026-09-05", to: "2027-03-07" },
      rules: { filter: { mode: "prefix", text: "14-1 Gold -" }, preset: "sprocket", court: { from: "description", label: "Court" } }
    });
    expect(r.body.suggestions[0]).toEqual({ filter: { mode: "prefix", text: "14-1 Gold -" }, count: 17 });
    expect(r.body.events).toHaveLength(22);
    expect(JSON.stringify(r.body)).not.toContain("0123456789abcdef0123456789abcdef");
    expect((await feedItems()).map((i) => i.SK)).toEqual(["FEED#CHECKS"]);
  });

  it("explains links that don't work", async () => {
    expect((await coord("POST", `/teams/${T}/feed/check`, { url: "http://cal.example.com/a.ics" })).body).toMatchObject({ error: "feed_bad_link" });
    const r = await coord("POST", `/teams/${T}/feed/check`, { url: "https://cal.example.com/gone.ics" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("feed_gone");
  });
});

describe("saving", () => {
  let rules: any;
  it("stores the link encrypted and the rules as version 1", async () => {
    rules = (await coord("POST", `/teams/${T}/feed/check`, { url: LINK })).body.rules;
    const r = await coord("PUT", `/teams/${T}/feed`, { url: LINK, rules, note: "First setup" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      connected: true, version: 1, rules,
      source: { host: "cal.example.com", masked: "cal.example.com/…/feed/0123…abcdef.ics", preset: "sprocket", calendarName: "My Calendar", lastCheck: { total: 22, matched: 17 } },
      history: [{ v: 1, note: "First setup", summary: 'Title starts with "14-1 Gold -"', by: COORD }]
    });
    const src = (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.feedSource(T) }))).Item!;
    expect(String(src.link)).toMatch(/^t1:/);
    expect(JSON.stringify(src)).not.toContain("0123456789abcdef0123456789abcdef");
    expect(await openLink(String(src.link), T)).toBe(LINK);
    await expect(openLink(String(src.link), "other-team")).rejects.toThrow();
    // The saved link is used when none is sent.
    fetched.length = 0;
    expect((await coord("POST", `/teams/${T}/feed/check`, {})).body.rules).toEqual(rules);
    expect(fetched).toEqual([LINK]);
  });

  it("makes a new version only when the rules change, and can go back to an old one", async () => {
    expect((await coord("PUT", `/teams/${T}/feed`, { rules })).body.version).toBe(1);
    const changed = { ...rules, types: [...rules.types, { when: "title", text: "Media", kind: "event" }] };
    const r2 = await coord("PUT", `/teams/${T}/feed`, { rules: changed, note: "Media days are events" });
    expect(r2.body).toMatchObject({ version: 2, rules: changed });
    expect(r2.body.history.map((h: any) => h.v)).toEqual([2, 1]);
    const back = await coord("POST", `/teams/${T}/feed/rules/1/restore`);
    expect(back.body).toMatchObject({ version: 3, rules });
    expect(back.body.history[0]).toMatchObject({ v: 3, note: "Back to version 1" });
  });

  it("checks a new link before replacing the old one", async () => {
    const bad = await coord("PUT", `/teams/${T}/feed`, { url: "https://cal.example.com/gone.ics", rules });
    expect(bad.status).toBe(422);
    expect((await coord("GET", `/teams/${T}/feed`)).body.source.host).toBe("cal.example.com");
    const ok = await coord("PUT", `/teams/${T}/feed`, { url: SECOND, rules: { ...rules, filter: { mode: "all" } } });
    expect(ok.body.source).toMatchObject({ host: "calendar.example.org", preset: "google", masked: "calendar.example.org/…/team.ics" });
  });

  it("refuses bad rules", async () => {
    expect((await coord("PUT", `/teams/${T}/feed`, { rules: { ...rules, types: [{ when: "title", text: "", kind: "practice" }] } })).status).toBe(400);
    expect((await coord("PUT", `/teams/${T}/feed`, { rules: { ...rules, fallback: "game" } })).status).toBe(400);
  });
});

describe("on/off switches", () => {
  it("the team switch stops checks and saves, but not reading or disconnecting", async () => {
    expect((await coord("PUT", `/teams/${T}/features`, { features: { calfeed: false } })).status).toBe(200);
    const r = await coord("POST", `/teams/${T}/feed/check`, {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Calendar feed sync is turned off for this team/);
    expect((await coord("GET", `/teams/${T}/feed`)).body.connected).toBe(true);
    expect((await coord("PUT", `/teams/${T}/features`, { features: { calfeed: true } })).status).toBe(200);
  });

  it("the club switch does the same for every team in the club", async () => {
    expect((await owner("PUT", "/admin/clubs/fc", { features: { calfeed: false } })).status).toBe(200);
    expect((await coord("POST", `/teams/${T}/feed/check`, {})).body.message).toMatch(/isn't included for your club/);
    expect((await owner("PUT", "/admin/clubs/fc", { features: { calfeed: true } })).status).toBe(200);
    expect((await coord("POST", `/teams/${T}/feed/check`, {})).status).toBe(200);
  });
});

describe("limits and disconnecting", () => {
  it("allows a few checks a minute", async () => {
    await put({ ...keys.feedChecks(T), times: Array(6).fill(Date.now()) });
    const r = await coord("POST", `/teams/${T}/feed/check`, {});
    expect(r.status).toBe(429);
    await put({ ...keys.feedChecks(T), times: [] });
  });

  it("forgets the link and every rules version", async () => {
    expect((await coord("DELETE", `/teams/${T}/feed`)).body).toEqual({ connected: false });
    expect(await feedItems()).toEqual([]);
    expect((await coord("GET", `/teams/${T}/feed`)).body).toEqual({ connected: false });
    expect((await coord("POST", `/teams/${T}/feed/check`, {})).body.message).toMatch(/Paste the team's calendar link/);
  });
});
