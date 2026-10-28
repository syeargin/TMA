import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-help";
process.env.MAIL_TRANSPORT = "memory";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { popularFrom } = await import("../../src/api/routes/help.js");
const { HELP_TOPICS, POPULAR_MIN_VIEWS, STARTER_PICKS, helpRolesFor } = await import("../../src/shared/help.js");
const { searchHelp, highlight, terms } = await import("../../src/shared/help-search.js");
const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any; headers: Record<string, unknown> };
async function call(method: string, path: string, sub: string | null, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined, headers: (r.headers ?? {}) as Record<string, unknown> };
}
const anon = (m: string, p: string, b?: unknown) => call(m, p, null, b);
const view = (topic: string, role = "parent", via = "browse") => anon("POST", "/public/help/events", { kind: "view", topic, role, via });
const month = new Date().toISOString().slice(0, 7);

describe("help guide content", () => {
  it("has 20 topics with unique ids, steps and working links between them", () => {
    expect(HELP_TOPICS).toHaveLength(20);
    const ids = new Set(HELP_TOPICS.map((t) => t.id));
    expect(ids.size).toBe(20);
    for (const t of HELP_TOPICS) {
      expect(t.id).toMatch(/^[a-z][a-z-]+$/);
      expect(t.steps.length).toBeGreaterThanOrEqual(2);
      for (const r of t.related) expect(ids.has(r), `${t.id} → ${r}`).toBe(true);
      expect(t.places.length).toBeGreaterThan(0);
      // Bold labels are closed.
      for (const s of [...t.steps, ...(t.tips ?? [])]) expect(s.split("**").length % 2, s).toBe(1);
    }
    for (const list of Object.values(STARTER_PICKS)) for (const id of list) expect(ids.has(id)).toBe(true);
    expect(HELP_TOPICS.filter((t) => t.role === "parent")).toHaveLength(9);
  });

  it("maps team roles to the guide's three groups", () => {
    expect(helpRolesFor(["parent"])).toEqual(["parent"]);
    expect(helpRolesFor(["coach", "parent"])).toEqual(["parent", "staff"]);
    expect(helpRolesFor(["finance"])).toEqual(["admin"]);
    expect(helpRolesFor(["food"])).toEqual(["staff"]);
    expect(helpRolesFor([])).toEqual([]);
  });
});

describe("help search", () => {
  const first = (q: string) => searchHelp(q, HELP_TOPICS)[0]?.topic.id;
  it("finds topics by title, keyword, other words and the start of a word", () => {
    expect(first("rsvp")).toBe("answer-availability");
    expect(first("venmo")).toBe("record-payment");
    expect(first("hotel")).toBe("travel-plans");
    expect(first("snack")).toBe("meal-signup");
    expect(first("cal")).toBe("add-to-calendar");
    expect(first("how do I add a practice")).toBe("add-practice");
    expect(first("unsubscribe")).toBe("change-emails");
    expect(first("line judge")).toBe("ref-jobs");
    expect(first("who hasn't answered")).toBe("see-answers");
  });
  it("needs every word to match, and ignores filler words", () => {
    expect(searchHelp("hotel zebra", HELP_TOPICS)).toEqual([]);
    expect(searchHelp("", HELP_TOPICS)).toEqual([]);
    expect(terms("How do I pay?").map((t) => t.word)).toEqual(["pay"]);
  });
  it("splits text into highlighted and bold parts without HTML", () => {
    expect(highlight("Tap **Record a payment** to pay", ["pay"])).toEqual([
      { text: "Tap " }, { text: "Record a ", bold: true }, { text: "pay", mark: true, bold: true }, { text: "ment", bold: true }, { text: " to " }, { text: "pay", mark: true }
    ]);
    expect(highlight("<b>x</b>", ["b"])).toEqual([{ text: "<" }, { text: "b", mark: true }, { text: ">x</" }, { text: "b", mark: true }, { text: ">" }]);
    // Only at the start of a word.
    expect(highlight("repay", ["pay"])).toEqual([{ text: "repay" }]);
  });
});

describe("help counts", () => {
  beforeAll(async () => {
    await freshTable();
    expect((await call("GET", "/me", "u-owner", undefined, "owner@example.com")).body.platformAdmin).toBe(true);
  });

  it("counts views and searches without signing in, and keeps nothing else", async () => {
    expect((await view("answer-availability")).status).toBe(204);
    expect((await view("answer-availability", "staff", "search")).status).toBe(204);
    expect((await anon("POST", "/public/help/events", { kind: "search", found: false })).status).toBe(204);
    expect((await anon("POST", "/public/help/events", { kind: "search", found: true })).status).toBe(204);
    const rows = (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `HELP#${month}` } }))).Items!;
    const bySk = Object.fromEntries(rows.map((r) => [r.SK, r.n]));
    expect(bySk).toEqual({ "VIEW#parent#answer-availability": 1, "VIEW#staff#answer-availability": 1, "OPEN#browse": 1, "OPEN#search": 1, SEARCH: 2, MISS: 1 });
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["PK", "SK", "n", "ttl", "type"]);
  });

  it("refuses unknown topics, roles and extra fields", async () => {
    expect((await view("not-a-topic")).status).toBe(400);
    expect((await view("join-team", "owner")).status).toBe(400);
    expect((await anon("POST", "/public/help/events", { kind: "search", found: false, q: "my email is x@y.z" })).status).toBe(400);
    expect((await anon("POST", "/public/help/events", "nope")).status).toBe(400);
  });

  it("shows the starting picks until a role has enough views, then the most opened", async () => {
    const r = await anon("GET", "/public/help/popular");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("public, max-age=300");
    expect(r.body.popular.parent).toEqual({ ids: STARTER_PICKS.parent, from: "starter" });

    const c = new Map<string, number>([["VIEW#parent#meal-signup", POPULAR_MIN_VIEWS - 10], ["VIEW#parent#travel-plans", 10], ["VIEW#none#join-team", 3]]);
    const p = popularFrom(c);
    expect(p.parent.from).toBe("counts");
    expect(p.parent.ids.slice(0, 2)).toEqual(["meal-signup", "travel-plans"]);
    expect(p.parent.ids).toHaveLength(5);
    expect(new Set(p.parent.ids).size).toBe(5);
    expect(p.staff.from).toBe("starter");
    expect(p.all.ids[0]).toBe("meal-signup");
  });

  it("lets only site owners see the counts", async () => {
    expect((await call("GET", "/admin/help", "u-someone", undefined, "someone@example.com")).status).toBe(403);
    expect((await anon("GET", "/admin/help")).status).toBe(401);
    const r = await call("GET", "/admin/help", "u-owner", undefined, "owner@example.com");
    expect(r.status).toBe(200);
    expect(r.body.topics[0]).toMatchObject({ id: "answer-availability", views: 2, thisMonth: 2, byRole: { parent: 1, staff: 1, admin: 0, none: 0 } });
    expect(r.body.topics).toHaveLength(20);
    expect(r.body).toMatchObject({ searches: 2, misses: 1, via: { browse: 1, search: 1, popular: 0 }, months: 3 });
  });
});
