import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-usage";
process.env.MAIL_TRANSPORT = "memory";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const U = await import("../../src/shared/usage.js");
const L = await import("../../src/lib/usage.js");
const { tagLinks } = await import("../../src/lib/mail/outbox.js");
const { PutCommand, QueryCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string | null, body?: unknown, email?: string, query?: Record<string, string>): Promise<Res> {
  const ev = event(method, path, sub, body, email);
  if (query) (ev as unknown as { queryStringParameters: Record<string, string> }).queryStringParameters = query;
  const r = await handler(ev);
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner", COACH = "u-coach", MIA = "u-mia", DAN = "u-dan";
const owner = (m: string, p: string, b?: unknown, q?: Record<string, string>) => call(m, p, OWNER, b, "owner@example.com", q);
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const T = "u13", T2 = "u14";
const member = (t: string, sub: string, roles: string[], pid = "") => put({ ...keys.member(t, sub), ...keys.memberGsi(t, sub), type: "Membership", status: "active", sub, roles, pid });
const rows = async (pk: string) => ((await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": pk } }))).Items ?? []);
const today = L.stamp().date;

describe("usage rules (shared)", () => {
  it("knows which requests are actions people took", () => {
    expect(U.actionOf("PUT", "/teams/t1/family/p1", '{"rsvp":{"e1":"yes"}}')).toEqual({ action: "answers", teamId: "t1" });
    expect(U.actionOf("PUT", "/teams/t1/family/p1", '{"travel":{}}')).toBeNull();
    expect(U.actionOf("POST", "/public/answer", "{}")).toEqual({ action: "answers", teamId: "" });
    expect(U.actionOf("PUT", "/teams/t1/events/fc/matches/2026-11-14-1", "{}")?.action).toBe("scores");
    expect(U.actionOf("PUT", "/teams/t1/events/e1", "{}")?.action).toBe("events");
    expect(U.actionOf("POST", "/teams/t1/payments", "{}")?.action).toBe("payments");
    expect(U.actionOf("GET", "/teams/t1", null)).toBeNull();
    expect(U.errorAreaOf("/teams/t1/events/e1")).toBe("Schedule");
    expect(U.errorAreaOf("/teams/t1/events/fc/matches/x")).toBe("Matches");
    expect(U.errorAreaOf("/teams/t1")).toBe("Opening a team");
    expect(U.errorAreaOf("/public/answer")).toBe("One-tap answer");
  });

  it("puts page-open times in buckets and finds the time 95% opened within", () => {
    expect(U.bucketOf(100)).toBe(0);
    expect(U.bucketOf(900)).toBe(3);
    expect(U.bucketOf(60000)).toBe(U.LOAD_BUCKETS.length - 1);
    const c = Array(U.LOAD_BUCKETS.length).fill(0);
    c[1] = 90; c[4] = 10;
    expect(U.p95(c)).toBe(1500);
    expect(U.p95(c.map(() => 0))).toBeNull();
    expect(U.kindOf(["parent"])).toBe("family");
    expect(U.kindOf(["parent", "coach"])).toBe("staff");
  });

  it("weeks start on Sunday, and counts expire 13 months on", () => {
    expect(L.weekOf("2026-10-30")).toBe("2026-10-25");
    expect(L.weekOf("2026-10-25")).toBe("2026-10-25");
    expect(L.monthsBetween("2026-07-01", "2026-10-30")).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(new Date(L.ttlFor("2026-10-30") * 1000).toISOString().slice(0, 10)).toBe("2027-11-01");
  });

  it("marks site links in emails as coming from an email, and leaves pictures and other sites alone", () => {
    const b = "https://teemhub.net";
    expect(tagLinks('<a href="https://teemhub.net/teams/t1/schedule">x</a>', true, b)).toBe('<a href="https://teemhub.net/teams/t1/schedule?via=email">x</a>');
    expect(tagLinks('<a href="https://teemhub.net/answer?t=abc&amp;v=yes">y</a>', true, b)).toContain("v=yes&amp;via=email");
    expect(tagLinks("Open https://teemhub.net/answer?t=1&v=2 now", false, b)).toBe("Open https://teemhub.net/answer?t=1&v=2&via=email now");
    expect(tagLinks("https://teemhub.net/unsubscribe#t=zz", false, b)).toBe("https://teemhub.net/unsubscribe?via=email#t=zz");
    expect(tagLinks('<img src="https://teemhub.net/brand/email-logo-white.png">', true, b)).toBe('<img src="https://teemhub.net/brand/email-logo-white.png">');
    expect(tagLinks("https://teemhub.netflix.com/x https://example.com", false, b)).toBe("https://teemhub.netflix.com/x https://example.com");
    expect(tagLinks("https://teemhub.net/x", false, "")).toBe("https://teemhub.net/x");
  });
});

describe("counting", () => {
  beforeAll(async () => {
    await freshTable();
    expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
    expect((await owner("POST", "/clubs", { clubId: "uc", name: "Usage Club" })).status).toBe(201);
    expect((await owner("POST", "/teams", { clubId: "uc", teamId: T, name: "Usage 13" })).status).toBe(201);
    expect((await owner("POST", "/teams", { clubId: "uc", teamId: T2, name: "Usage 14" })).status).toBe(201);
    await put({ ...keys.event(T, "pr"), type: "Event", eid: "pr", kind: "practice", title: "Practice", date: today });
    for (const pid of ["p1", "p2", "p3", "p4"]) await put({ ...keys.player(T, pid), type: "Player", first: pid });
    for (const pid of ["q1", "q2", "q3", "q4"]) await put({ ...keys.player(T2, pid), type: "Player", first: pid });
    await member(T, COACH, ["coach"]); await member(T, MIA, ["parent"], "p1"); await member(T, DAN, ["parent"], "p2");
    await member(T2, "u-solo", ["parent"], "q1");
  });

  it("remembers the day a member opens their team, once a day, and counts them once a week", async () => {
    expect((await call("GET", `/teams/${T}`, MIA)).status).toBe(200);
    expect((await call("GET", `/teams/${T}`, MIA)).status).toBe(200);
    expect((await call("GET", `/teams/${T}`, COACH)).status).toBe(200);
    const seen = await rows(`SEEN#${T}`);
    expect(seen.map((s) => [s.SK, s.day, s.kind]).sort()).toEqual([[COACH, today, "staff"], [MIA, today, "family"]]);
    // Nothing else about the person: no pages, no times.
    expect(Object.keys(seen[0]).sort()).toEqual(["PK", "SK", "clubId", "day", "kind", "ttl", "type", "week"]);
    const week = await L.weeklyRows(L.weekOf(today), today);
    expect(week.filter((w) => String(w.SK).includes(`#${T}#`)).map((w) => [String(w.SK).split("#").at(-1), w.n]).sort()).toEqual([["family", 1], ["staff", 1]]);
    // A site owner looking in isn't a member: not counted.
    expect((await owner("GET", `/teams/${T}`)).status).toBe(200);
    expect((await rows(`SEEN#${T}`)).length).toBe(2);
  });

  it("counts pages opened, with the team only for people on it", async () => {
    const ev = { kind: "view", area: "schedule", teamId: T, device: "phone", source: "email", ms: 640, commit: "abc1234" };
    expect((await call("POST", "/usage/events", MIA, ev)).status).toBe(204);
    expect((await call("POST", "/usage/events", "u-stranger", ev)).status).toBe(204);
    expect((await call("POST", "/usage/events", MIA, { ...ev, area: "nope" })).status).toBe(400);
    expect((await call("POST", "/usage/events", MIA, { kind: "share", teamId: T })).status).toBe(204);
    const s = L.stamp();
    const usage = await rows(`USAGE#${s.month}`);
    const sk = (x: string) => usage.find((r) => r.SK === `D#${s.dd}#${x}`)?.n;
    expect(sk(`P#uc#${T}#schedule`)).toBe(1);
    expect(sk("P#-#-#schedule")).toBe(1); // the stranger: counted, but not for the team
    expect(sk("V#uc#email")).toBe(1);
    expect(sk("DEV#uc#phone")).toBe(1);
    expect(sk(`L#phone#schedule#${U.bucketOf(640)}`)).toBe(2);
    expect(sk(`ACT#uc#${T}#shares`)).toBe(1);
    expect((await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: "RELEASES", SK: "C#abc1234" } }))).Item?.at).toBeTruthy();
  });

  it("takes only public pages without a sign-in", async () => {
    expect((await call("POST", "/public/usage", null, { kind: "view", area: "help", device: "computer", source: "direct" })).status).toBe(204);
    expect((await call("POST", "/public/usage", null, { kind: "view", area: "fund", device: "computer" })).status).toBe(400);
    expect((await call("POST", "/public/usage", null, { kind: "share", teamId: T })).status).toBe(400);
    expect((await call("POST", "/public/usage", null, { kind: "error", area: "help" })).status).toBe(204);
  });

  it("counts requests, what people did, and failures", async () => {
    expect((await call("PUT", `/teams/${T}/family/p1`, MIA, { rsvp: { pr: "yes" } })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/family/p1`, DAN, { rsvp: { pr: "yes" } })).status).toBe(403);
    const s = L.stamp();
    const usage = await rows(`USAGE#${s.month}`);
    expect(usage.find((r) => r.SK === `D#${s.dd}#ACT#uc#${T}#answers`)?.n).toBe(1);
    const health = await rows(`HEALTH#${s.month}`);
    const hour = health.find((r) => r.SK === `D#${s.dd}#H#${s.hour}`)!;
    expect(hour.n).toBeGreaterThan(5);
    expect(hour.err).toBe(0);
    await L.countRequest(500, "Schedule");
    const after = await rows(`HEALTH#${s.month}`);
    expect(after.find((r) => r.SK === `D#${s.dd}#E#Schedule`)).toMatchObject({ n: 1, status: 500 });
    expect(after.find((r) => r.SK === `D#${s.dd}#CE#help`)?.n).toBe(1);
  });

  it("shows site owners the totals, and nobody else", async () => {
    expect((await call("GET", "/admin/usage", COACH)).status).toBe(403);
    const r = await owner("GET", "/admin/usage", undefined, { period: "7d", club: "uc" });
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.period).toBe("7d");
    expect(b.tiles).toMatchObject({ active7: 2, active7Family: 1, active7Staff: 1, members: 4, teamsInUse: 1, teams: 2, joined: 3, roster: 8, needsLook: 1 });
    // Today's practice: 4 players on u13, one answered.
    expect(b.tiles.answeredPct).toBe(25);
    expect(b.funnel).toEqual({ roster: 8, invited: 3, joined: 3, answeredOnce: 1, active30: 1 });
    expect(b.teams.map((t: any) => [t.teamId, t.status])).toEqual([[T2, "notStarted"], [T, "steady"]]);
    expect(b.teams.find((t: any) => t.teamId === T)).toMatchObject({ roster: 4, joined: 2, active7: 2, lastSeen: today, opens: 1 });
    expect(b.weekly).toHaveLength(12);
    expect(b.weekly.at(-1)).toMatchObject({ week: L.weekOf(today), family: 1, staff: 1 });
    expect(b.sources.find((s: any) => s.id === "email").n).toBe(1);
    expect(b.actions.find((a: any) => a.id === "answers")).toMatchObject({ n: 1, prev: 0 });
    expect(b.features.find((f: any) => f.label === "Schedule and availability")).toMatchObject({ teams: 1, of: 2, opens: 1 });
    expect(b.heat.flat().reduce((a: number, x: number) => a + x, 0)).toBeGreaterThanOrEqual(3);
    // Every club, and the season, work too.
    expect((await owner("GET", "/admin/usage", undefined, { period: "season" })).body.club).toBe("all");
  });

  it("shows site owners the site's health", async () => {
    expect((await call("GET", "/admin/health", COACH)).status).toBe(403);
    const b = (await owner("GET", "/admin/health", undefined, { period: "24h" })).body;
    expect(b.requests.total).toBeGreaterThan(5);
    expect(b.requests.failed).toBe(1);
    expect(b.points).toHaveLength(24);
    expect(b.errors.map((e: any) => [e.where, e.area])).toEqual(expect.arrayContaining([["server", "Schedule"], ["browser", "Help"]]));
    expect(b.pages.phoneP95).toBe(750);
    expect(b.releases[0]).toMatchObject({ commit: "abc1234" });
    expect(b.feeds.failing).toEqual([]);
    expect(b.liveNow).toBe(0);
    expect((await owner("GET", "/admin/health", undefined, { period: "30d" })).body.points).toHaveLength(30);
  });

  it("forgets the day someone last opened a team when they leave it", async () => {
    expect((await owner("DELETE", `/teams/${T}/members/${MIA}`)).status).toBe(204);
    expect((await rows(`SEEN#${T}`)).map((s) => s.SK)).toEqual([COACH]);
  });
});
