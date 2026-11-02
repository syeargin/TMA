import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-feedback";
process.env.MAIL_TRANSPORT = "memory";
process.env.MFA_CHECK = "off";
process.env.SITE_URL = "https://teemhub.net";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { memoryOutbox } = await import("../../src/lib/mail/outbox.js");
const { PutCommand, GetCommand, QueryCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string | null, body?: unknown, ip = "127.0.0.1"): Promise<Res> {
  const ev = event(method, path, sub, body);
  (ev.requestContext.http as { sourceIp: string }).sourceIp = ip;
  const r = await handler(ev);
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const OWNER = "u-owner", OWNER2 = "u-owner2", MIA = "u-mia", KIM = "u-kim", ADA = "u-ada";
const T = "t13", T2 = "t14";
const member = (t: string, sub: string, roles: string[], extra: Record<string, unknown> = {}) =>
  put({ ...keys.member(t, sub), ...keys.memberGsi(t, sub), type: "Membership", status: "active", sub, roles, pid: "", ...extra });
const profile = (sub: string, email: string, firstName: string) => put({ ...keys.profile(sub), type: "UserProfile", sub, email, firstName, lastName: "Test" });
const shot = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");
const sentTo = (to: string) => memoryOutbox.filter((m) => m.to === to);

beforeAll(async () => {
  await freshTable();
  await put({ ...keys.platformAdmin(OWNER), type: "PlatformAdmin" });
  await put({ ...keys.platformAdmin(OWNER2), type: "PlatformAdmin" });
  await profile(OWNER, "sam@example.com", "Sam");
  await profile(OWNER2, "pat@example.com", "Pat");
  await profile(MIA, "mia@example.com", "Mia");
  await profile(KIM, "kim@example.com", "Kim");
  await put({ ...keys.settings(T), teamName: "A5 13 Tom" });
  await put({ ...keys.settings(T2), teamName: "A5 14 Black" });
  await member(T, MIA, ["parent"], { email: "mia@example.com", firstName: "Mia" });
  await member(T, KIM, ["coordinator", "coach"], { email: "kim@example.com", firstName: "Kim", lastName: "Lee" });
  await member(T, ADA, ["admin"], { email: "ada@example.com", firstName: "Ada" });
  await member(T2, MIA, ["parent"], { email: "mia@example.com" });
  await member(T2, ADA, ["admin"], { email: "ada@example.com", firstName: "Ada" });
}, 60_000);

describe("questions & feedback", () => {
  let problemId = "";

  it("sends a team question to the coordinators, replying straight to the family", async () => {
    memoryOutbox.length = 0;
    const r = await call("POST", "/feedback", MIA, { kind: "question", to: "team", teamId: T, message: "Do we bring our own volleyballs?", page: { path: "/teams/t13/tournaments/fc", title: "Fall Classic" } });
    expect(r.status).toBe(201);
    expect(r.body.ref).toMatch(/^TH-10\d\d$/);
    expect(r.body.sentTo).toEqual(["Kim Lee"]);
    const mail = sentTo("kim@example.com");
    expect(mail.length).toBe(1);
    expect(mail[0].replyTo).toBe("mia@example.com");
    expect(mail[0].subject).toBe("Question from Mia Test · A5 13 Tom");
    expect(mail[0].text).toContain("Do we bring our own volleyballs?");
    // Admins aren't copied when there's a coordinator, and site owners haven't asked for team questions.
    expect(sentTo("ada@example.com").length).toBe(0);
    expect(sentTo("sam@example.com").length).toBe(0);
  });

  it("falls back to the team's admins when it has no coordinator, and only for your own teams", async () => {
    memoryOutbox.length = 0;
    expect((await call("POST", "/feedback", MIA, { kind: "question", to: "team", teamId: T2, message: "When are dues due?" })).body.sentTo).toEqual(["Ada"]);
    expect(sentTo("ada@example.com").length).toBe(1);
    expect((await call("POST", "/feedback", KIM, { kind: "question", to: "team", teamId: T2, message: "Not my team though" })).status).toBe(403);
  });

  it("sends a problem with a screenshot to site owners", async () => {
    memoryOutbox.length = 0;
    const r = await call("POST", "/feedback", MIA, {
      kind: "problem", teamId: T, message: "The hotel didn't save. Tried twice.", screenshot: shot,
      page: { path: "/teams/t13/tournaments/fc", title: "Fall Classic · Travel plans" }, error: { code: "save_failed", message: "That didn't save", at: "2026-11-02T18:42:00Z" },
      device: "iPhone · Safari 19", version: "v1.9.3"
    });
    expect(r.status).toBe(201);
    problemId = r.body.id;
    expect(sentTo("sam@example.com")[0].subject).toContain("Problem");
    expect(sentTo("pat@example.com").length).toBe(1);
    const s = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `FB#${problemId}`, SK: "SHOT" } }));
    expect(s.Item?.ttl).toBeGreaterThan(Date.now() / 1000 + 59 * 86400);
    expect(s.Item?.ttl).toBeLessThan(Date.now() / 1000 + 61 * 86400);
    // Not a picture: refused.
    expect((await call("POST", "/feedback", MIA, { kind: "problem", message: "Here's my file", screenshot: "data:text/html;base64,PGI+" })).status).toBe(400);
  });

  it("shows site owners their inbox, with team questions only once they ask for them", async () => {
    expect((await call("GET", "/admin/feedback", MIA)).status).toBe(403);
    let r = await call("GET", "/admin/feedback", OWNER);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { kind: string }) => i.kind)).toEqual(["problem"]);
    expect(r.body.stats.new).toBe(1);
    const item = r.body.items[0];
    expect(item.hasShot).toBe(true);
    expect(item.email).toBe("mia@example.com");
    expect(item.sub).toBeUndefined();
    expect((await call("GET", `/admin/feedback/${problemId}/screenshot`, OWNER)).body.screenshot).toBe(shot);

    expect((await call("PUT", "/admin/feedback/settings", OWNER, { teamQuestions: true, emailNew: true })).status).toBe(200);
    r = await call("GET", "/admin/feedback", OWNER);
    expect(r.body.items.length).toBe(3);
    // Pat's view is Pat's own choice.
    expect((await call("GET", "/admin/feedback", OWNER2)).body.items.length).toBe(1);

    memoryOutbox.length = 0;
    await call("POST", "/feedback", MIA, { kind: "question", to: "team", teamId: T, message: "Is practice still on tonight?" });
    expect(sentTo("sam@example.com")[0].subject).toContain("Team question (copy)");
    expect(sentTo("pat@example.com").length).toBe(0);
  });

  it("groups problems with the same error", async () => {
    await call("POST", "/feedback", KIM, { kind: "problem", message: "Travel plans won't save", error: { code: "save_failed", message: "That didn't save", at: "2026-11-02T19:00:00Z" } });
    const r = await call("GET", "/admin/feedback", OWNER);
    const p = r.body.items.find((i: { id: string }) => i.id === problemId);
    expect(p.similar.length).toBe(1);
    expect(r.body.stats.sameError).toBe(2);
  });

  it("replies by email, and the sender sees the reply on their account", async () => {
    memoryOutbox.length = 0;
    const r = await call("POST", `/admin/feedback/${problemId}/reply`, OWNER, { message: "Fixed this morning, thanks for telling us." });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("waiting");
    const mail = sentTo("mia@example.com")[0];
    expect(mail.subject).toBe("Re: the problem you reported (TH-1003)");
    expect(mail.text).toContain("Fixed this morning");
    expect(mail.text).toContain("— Sam, Teem Hub");
    const mine = (await call("GET", "/me/feedback", MIA)).body.items;
    const p = mine.find((i: { id: string }) => i.id === problemId);
    expect(p.replies[0]).toMatchObject({ byName: "Sam", message: "Fixed this morning, thanks for telling us." });
    expect((await call("PUT", `/admin/feedback/${problemId}`, OWNER, { status: "closed" })).body.status).toBe("closed");
    expect((await call("PUT", `/admin/feedback/${problemId}`, MIA, { status: "new" })).status).toBe(403);
  });

  it("takes messages from the sign-in page, ignores bots, and limits how many", async () => {
    memoryOutbox.length = 0;
    const ok = await call("POST", "/public/feedback", null, { kind: "question", email: "Jo@Example.com", message: "I can't sign in on my new phone", page: { path: "/signin", title: "Sign in" } }, "10.0.0.1");
    expect(ok.status).toBe(201);
    expect(sentTo("sam@example.com").length).toBe(1);
    const bot = await call("POST", "/public/feedback", null, { kind: "idea", email: "bot@example.com", message: "Buy cheap stuff now", website: "http://spam" }, "10.0.0.2");
    expect(bot.status).toBe(201);
    expect((await call("GET", "/admin/feedback", OWNER)).body.items.some((i: { email: string }) => i.email === "bot@example.com")).toBe(false);
    expect((await call("POST", "/public/feedback", null, { kind: "question", message: "No email here" }, "10.0.0.3")).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call("POST", "/public/feedback", null, { kind: "idea", email: "lots@example.com", message: `Idea number ${i}` }, `10.0.1.${i}`)).status;
    expect(last).toBe(409);
  });

  it("deletes what you sent with your account", async () => {
    await member(T, KIM, ["coach"], { email: "kim@example.com" });
    expect((await call("DELETE", "/me", KIM, { confirm: "DELETE" })).status).toBe(204);
    const left = await ddb.send(new QueryCommand({ TableName: TABLE, IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :p", ExpressionAttributeValues: { ":p": `USER#${KIM}#FB` } }));
    expect(left.Items ?? []).toEqual([]);
  });
});
