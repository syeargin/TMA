import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-calendars";
process.env.MAIL_TRANSPORT = "memory";
process.env.SITE_URL = "https://teemhub.net";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { feedIcs } = await import("../../src/lib/calendar-feed.js");
const { PutCommand, GetCommand, QueryCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any; headers: Record<string, unknown> };
async function call(method: string, path: string, sub: string | null, body?: unknown, query?: Record<string, string>): Promise<Res> {
  const ev = event(method, path, sub, body);
  if (query) (ev as unknown as { queryStringParameters: Record<string, string> }).queryStringParameters = query;
  const r = await handler(ev);
  const text = typeof r.body === "string" ? r.body : "";
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* .ics */ }
  return { status: r.statusCode ?? 0, body: parsed, headers: (r.headers ?? {}) as Record<string, unknown> };
}
const feed = (token: string) => call("GET", "/public/calendar.ics", null, undefined, { k: token });
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const MIA = "u-mia", DAN = "u-dan";
const T = "t13", T2 = "t12";
const member = (t: string, sub: string, status = "active") => put({ ...keys.member(t, sub), ...keys.memberGsi(t, sub), type: "Membership", status, sub, roles: ["parent"], pid: "" });

// Dates near "now", so they're inside the feed's window whatever day the tests run.
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  await freshTable();
  await put({ ...keys.settings(T), teamName: "A5 13 Tom" });
  await put({ ...keys.settings(T2), teamName: "Lakeside U12" });
  await put({ ...keys.event(T, "p1"), kind: "practice", title: "Practice", date: day(3), time: "6:00 PM", endTime: "8:00 PM", location: "A5 Sportsplex", court: "6", uniformColor: "Navy" });
  await put({ ...keys.event(T, "fc"), kind: "tournament", title: "Fall Classic", date: day(10), endDate: day(11), location: "GWCC", arrival: "7:15 AM", hotel: "Riverside Suites", hotelCode: "TEST13" });
  await put({ ...keys.event(T, "party"), kind: "event", title: "Team party", date: day(5), time: "5:00 PM", cancelled: [day(5)] });
  await put({ ...keys.event(T, "old"), kind: "event", title: "Way back", date: day(-60) });
  await put({ ...keys.event(T2, "g1"), kind: "event", title: "Game", date: day(4), time: "10:00 AM" });
  await member(T, MIA);
  await member(T2, MIA);
  await member(T, DAN);
}, 60_000);

describe("calendar links", () => {
  let token = "";

  it("makes a link for one team, and only for teams you're on", async () => {
    expect((await call("PUT", `/me/calendars/teams/${T2}`, DAN, { types: ["practice"] })).status).toBe(403);
    expect((await call("PUT", `/me/calendars/teams/${T}`, MIA, { types: [] })).status).toBe(400);
    const r = await call("PUT", `/me/calendars/teams/${T}`, MIA, { types: ["tournament", "practice", "event"], app: "apple" });
    expect(r.status).toBe(200);
    expect(r.body.types).toEqual(["practice", "tournament", "event"]);
    token = r.body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The pointer row holds a hash, never the link itself.
    const ptrs = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `USER#${MIA}` } }));
    expect(ptrs.Items?.length).toBe(1);
  });

  it("serves the schedule as a calendar, with cancelled dates marked and no old dates", async () => {
    const r = await feed(token);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toContain("text/calendar");
    const ics = String(r.body).replace(/\r\n /g, "");
    expect(ics).toContain("X-WR-CALNAME:A5 13 Tom (Teem Hub)");
    expect(ics).toContain("SUMMARY:Practice");
    expect(ics).toContain("LOCATION:A5 Sportsplex\\, Court 6");
    expect(ics).toContain("Practice uniform: Navy");
    expect(ics).toContain("SUMMARY:Fall Classic");
    expect(ics).toContain(`DTSTART;VALUE=DATE:${day(10).replace(/-/g, "")}`);
    expect(ics).toContain(`DTEND;VALUE=DATE:${day(12).replace(/-/g, "")}`);
    expect(ics).toContain("Hotel: Riverside Suites (code TEST13)");
    expect(ics).toContain("SUMMARY:Cancelled: Team party");
    expect(ics).toContain("TRANSP:TRANSPARENT");
    expect(ics).not.toContain("Way back");
    expect(ics).toContain(`UID:${T}-p1@feed.teemhub.net`);
    expect(ics).toContain(`URL:https://teemhub.net/teams/${T}/tournaments/fc`);
    // When the calendar app last checked.
    const row = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${MIA}`, SK: `CAL#team#${T}` } }));
    expect(row.Item?.lastFetchAt).toBeTruthy();
    expect(row.Item?.fetches).toBe(1);
    await feed(token);
    expect((await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${MIA}`, SK: `CAL#team#${T}` } }))).Item?.fetches).toBe(1);
  });

  it("changes what's included without changing the link", async () => {
    const r = await call("PUT", `/me/calendars/teams/${T}`, MIA, { types: ["tournament"] });
    expect(r.body.token).toBe(token);
    const ics = String((await feed(token)).body);
    expect(ics).toContain("Fall Classic");
    expect(ics).not.toContain("SUMMARY:Practice");
    expect(ics).not.toContain("Team party");
  });

  it("resets the link: the old one stops working", async () => {
    const r = await call("POST", `/me/calendars/teams/${T}/reset`, MIA);
    expect(r.status).toBe(200);
    expect(r.body.token).not.toBe(token);
    expect((await feed(token)).status).toBe(404);
    expect((await feed(r.body.token)).status).toBe(200);
    token = r.body.token;
  });

  it("puts every team in one calendar, each event named with its team", async () => {
    expect((await call("PUT", "/me/calendars/all", DAN, { teams: { [T]: ["practice"], [T2]: ["event"] } })).status).toBe(403);
    const r = await call("PUT", "/me/calendars/all", MIA, { teams: { [T]: ["practice"], [T2]: ["event"] }, app: "google" });
    expect(r.status).toBe(200);
    const ics = String((await feed(r.body.token)).body);
    expect(ics).toContain("X-WR-CALNAME:My teams (Teem Hub)");
    expect(ics).toContain("SUMMARY:A5 13 Tom · Practice");
    expect(ics).toContain("SUMMARY:Lakeside U12 · Game");
    expect(ics).not.toContain("Fall Classic");
    const list = await call("GET", "/me/calendars", MIA);
    expect(list.body.links.map((l: { scope: string }) => l.scope).sort()).toEqual(["all", "team"]);
  });

  it("drops a team from the calendar once you leave it", async () => {
    await member(T2, MIA, "removed");
    const all = (await call("GET", "/me/calendars", MIA)).body.links.find((l: { scope: string }) => l.scope === "all");
    const ics = String((await feed(all.token)).body);
    expect(ics).toContain("A5 13 Tom · Practice");
    expect(ics).not.toContain("Lakeside");
    await member(T2, MIA);
  });

  it("stops a link, and turns away made-up ones", async () => {
    expect((await call("DELETE", `/me/calendars/teams/${T}`, MIA)).status).toBe(204);
    expect((await feed(token)).status).toBe(404);
    expect((await feed("nope")).status).toBe(404);
    expect((await call("GET", "/public/calendar.ics", null)).status).toBe(404);
  });

  it("removes calendar links with the account", async () => {
    const all = (await call("GET", "/me/calendars", MIA)).body.links.find((l: { scope: string }) => l.scope === "all");
    const del = await call("DELETE", "/me", MIA, { confirm: "DELETE" });
    expect(del.status).toBe(204);
    expect((await feed(all.token)).status).toBe(404);
    const left = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `USER#${MIA}` } }));
    expect(left.Items ?? []).toEqual([]);
  });
});

describe("the .ics file", () => {
  const team = (items: unknown[]) => ({ team: { teamId: "x", teamName: "X", events: [], items } as never, zone: "America/New_York", types: ["practice", "tournament", "event"] as never, prefix: false });
  const now = new Date("2026-11-01T12:00:00Z");

  it("reads times written several ways, in the team's time zone", () => {
    const it = (key: string, time: string) => ({ key, kind: "practice", title: "Practice", date: "2026-11-05", end: "2026-11-05", time, location: "", note: "", travel: false, cancelled: false });
    const ics = feedIcs("X", [team([it("a", "6:00 PM – 8:00 PM"), it("b", "6 – 8 PM"), it("c", "18:30"), it("d", "Time TBD")])], "https://teemhub.net", now);
    const ev = (k: string) => ics.split("BEGIN:VEVENT").find((v) => v.includes(`UID:x-${k}@`))!;
    // Nov 5 is after the clocks change: Eastern is UTC-5.
    expect(ev("a")).toContain("DTSTART:20261105T230000Z");
    expect(ev("a")).toContain("DTEND:20261106T010000Z");
    expect(ev("b")).toContain("DTSTART:20261105T230000Z");
    expect(ev("c")).toContain("DTSTART:20261105T233000Z");
    expect(ev("c")).toContain("DTEND:20261106T013000Z");
    expect(ev("d")).toContain("DTSTART;VALUE=DATE:20261105");
  });

  it("folds long lines and escapes text", () => {
    const long = { key: "l", kind: "event", title: "A, very; long\\ title " + "x".repeat(120), date: "2026-11-05", end: "2026-11-05", time: "", location: "", note: "", travel: false, cancelled: false };
    const ics = feedIcs("X", [team([long])], "https://teemhub.net", now);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, "")).toContain("SUMMARY:A\\, very\\; long\\\\ title");
  });
});
