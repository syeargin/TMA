import { beforeAll, beforeEach, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-mail";
process.env.MAIL_TRANSPORT = "memory";
process.env.SITE_URL = "https://dev.teemhub.net";
process.env.APP_ENV = "dev";
const { event, freshTable } = await import("../api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { memoryOutbox, applySesEvent, sendDeliveries, fromHeader, deliveryKey } = await import("../../src/lib/mail/outbox.js");
const { render, rolePhrase } = await import("../../src/lib/mail/templates.js");
const { GetCommand, PutCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const OWNER = "u-owner";
const owner = (m: string, p: string, b?: unknown) => call(m, p, OWNER, b, "owner@example.com");
const get = async (key: { PK: string; SK: string }) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: key }))).Item!;
const invites = async () => (await owner("GET", "/teams/m13/invites")).body.invites as any[];
const last = () => memoryOutbox[memoryOutbox.length - 1];

beforeAll(async () => {
  await freshTable();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await owner("PUT", "/me", { firstName: "Sam", lastName: "Yates" })).status).toBe(200);
  expect((await owner("POST", "/clubs", { clubId: "mc", name: "Mail Club", colors: { primary: "#1F4E3D", accent: "#E0A526" }, adminEmails: ["director@example.com"] })).status).toBe(201);
  expect((await owner("POST", "/teams", { clubId: "mc", teamId: "m13", name: "Mail 13 Blue" })).status).toBe(201);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.player("m13", "p1"), type: "Player", first: "Maya", last: "Parker" } }));
});
beforeEach(() => { memoryOutbox.length = 0; });

describe("team invite emails", () => {
  it("emails an invite when it's made, from the team, with the player's first name only", async () => {
    expect((await owner("POST", "/teams/m13/invites", { email: "Jordan@Example.com", roles: ["parent"], pid: "p1" })).status).toBe(201);
    expect(memoryOutbox).toHaveLength(1);
    const m = last();
    expect(m).toMatchObject({ to: "jordan@example.com", fromName: "Mail 13 Blue via Teem Hub (dev)", subject: "Sam Yates invited you to Mail 13 Blue on Teem Hub" });
    expect(m.tags).toMatchObject({ env: "dev", msg: "invite" });
    expect(m.html).toContain("Maya&#39;s parent or guardian");
    expect(m.html).not.toContain("Parker");
    expect(m.html).toContain("https://dev.teemhub.net/signup?via=email#email=jordan%40example.com");
    expect(m.html).toContain("#1F4E3D");
    expect(m.text).toContain("Accept the invite: https://dev.teemhub.net/signup?via=email#email=jordan%40example.com");
    const inv = (await invites()).find((i) => i.email === "jordan@example.com");
    expect(inv).toMatchObject({ emailStatus: "sent", emailCount: 1 });
  });

  it("won't email the same invite again within a few minutes", async () => {
    expect((await owner("POST", "/teams/m13/invites/jordan@example.com/send")).status).toBe(429);
    expect(memoryOutbox).toHaveLength(0);
  });

  it("shows a bounce on the invite, and won't send to that address again", async () => {
    const inv = await get(keys.invite("jordan@example.com", "m13"));
    const first = String(inv.emailDelivery);
    expect(await applySesEvent({ eventType: "Bounce", bounce: { bounceType: "Transient" }, mail: { tags: { delivery: [first] } } })).toBeNull();
    expect(await applySesEvent({ eventType: "Bounce", bounce: { bounceType: "Permanent", bounceSubType: "General" }, mail: { tags: { delivery: [first] } } })).toBe("bounced");
    expect(await get(keys.invite("jordan@example.com", "m13"))).toMatchObject({ emailStatus: "bounced", emailDetail: expect.stringContaining("typo") });
    // A delivery event after the bounce doesn't undo it.
    expect(await applySesEvent({ eventType: "Delivery", mail: { tags: { delivery: [first] } } })).toBeNull();

    // Not to a bouncing address again: fix the address instead.
    expect((await owner("POST", "/teams/m13/invites/jordan@example.com/send")).status).toBe(409);
    expect(memoryOutbox).toHaveLength(0);
    // Inviting the address again (once it's fixed at their end) starts over.
    expect((await owner("POST", "/teams/m13/invites", { email: "jordan@example.com", roles: ["parent"], pid: "p1" })).status).toBe(201);
    expect(memoryOutbox).toHaveLength(1);
    const again = await get(keys.invite("jordan@example.com", "m13"));
    expect(again).toMatchObject({ emailStatus: "sent", emailCount: 1 });
    expect(again.emailDelivery).not.toBe(first);
    // A late event about the first email doesn't touch the newer one.
    await applySesEvent({ eventType: "Complaint", mail: { tags: { delivery: [first] } } });
    expect(await get(keys.invite("jordan@example.com", "m13"))).toMatchObject({ emailStatus: "sent" });
    expect(await applySesEvent({ eventType: "Delivery", mail: { tags: { delivery: [String(again.emailDelivery)] } } })).toBe("delivered");
    expect(await get(keys.invite("jordan@example.com", "m13"))).toMatchObject({ emailStatus: "delivered" });
  });

  it("can save an invite without emailing it, and email every waiting one later", async () => {
    expect((await owner("POST", "/teams/m13/invites", { email: "coach@example.com", roles: ["coach", "admin"], sendEmail: false })).status).toBe(201);
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      ...keys.invite("imported@example.com", "m13"), ...keys.inviteGsi("imported@example.com", "m13"),
      type: "Invite", teamId: "m13", email: "imported@example.com", roles: ["parent"], at: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + 14 * 86400, source: "import" } }));
    expect(memoryOutbox).toHaveLength(0);
    const r = await owner("POST", "/teams/m13/invites/send-waiting");
    expect(r).toMatchObject({ status: 202, body: { queued: 2 } });
    expect(memoryOutbox.map((m) => m.to).sort()).toEqual(["coach@example.com", "imported@example.com"]);
    expect(memoryOutbox.find((m) => m.to === "coach@example.com")!.html).toContain("a coach and a team admin");
    expect((await owner("POST", "/teams/m13/invites/send-waiting")).body.queued).toBe(0);
  });

  it("revives an expired invite when it's emailed again", async () => {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      ...keys.invite("late@example.com", "m13"), ...keys.inviteGsi("late@example.com", "m13"),
      type: "Invite", teamId: "m13", email: "late@example.com", roles: ["parent"], at: "2026-01-01T00:00:00Z", ttl: Math.floor(Date.now() / 1000) - 3600 } }));
    expect((await invites()).find((i) => i.email === "late@example.com").expired).toBe(true);
    const r = await owner("POST", "/teams/m13/invites/late@example.com/send");
    expect(r.status).toBe(202);
    expect(Date.parse(r.body.expires)).toBeGreaterThan(Date.now() + 13 * 86400_000);
    expect((await invites()).find((i) => i.email === "late@example.com").expired).toBeUndefined();
    expect(last().to).toBe("late@example.com");
  });

  it("is for people who can invite", async () => {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("m13", "u-par"), ...keys.memberGsi("m13", "u-par"), type: "Membership", status: "active", sub: "u-par", roles: ["parent", "coach"], email: "par@example.com" } }));
    expect((await call("POST", "/teams/m13/invites/late@example.com/send", "u-par")).status).toBe(403);
    expect((await call("POST", "/teams/m13/invites/send-waiting", "u-par")).status).toBe(403);
    expect((await owner("POST", "/teams/m13/invites/nobody@example.com/send")).status).toBe(404);
  });

  it("sends each delivery only once", async () => {
    const inv = await get(keys.invite("late@example.com", "m13"));
    const id = String(inv.emailDelivery);
    expect(await sendDeliveries([id, id])).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(memoryOutbox).toHaveLength(0);
    expect((await get(deliveryKey(id))).ttl).toBeGreaterThan(Date.now() / 1000 + 89 * 86400);
  });
});

describe("club admin invites", () => {
  it("emails the first admins of a new club, and again on request", async () => {
    const club = (await owner("GET", "/clubs/mc")).body;
    expect(club.invites[0]).toMatchObject({ email: "director@example.com", emailStatus: "sent" });
    expect((await owner("POST", "/clubs/mc/invites/director@example.com/send")).status).toBe(429);
    expect((await owner("POST", "/clubs/mc/admins", { email: "deputy@example.com" })).status).toBe(201);
    expect(last()).toMatchObject({ to: "deputy@example.com", fromName: "Mail Club via Teem Hub (dev)", subject: "You're invited to be a club admin of Mail Club" });
  });

  it("tells a club admin when their two-step sign-in was reset", async () => {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin("mc", "u-dir"), ...keys.clubAdminGsi("mc", "u-dir"), type: "ClubAdmin", email: "director@example.com", firstName: "Dee" } }));
    expect((await owner("POST", "/clubs/mc/admins/u-dir/reset-mfa")).status).toBe(204);
    expect(last()).toMatchObject({ to: "director@example.com", subject: "Your Teem Hub two-step sign-in was reset", fromName: "Teem Hub (dev)" });
    expect(last().html).toContain("Hi Dee,");
  });
});

describe("account notices", () => {
  it("confirms an account deletion to its address", async () => {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.profile("u-gone"), type: "UserProfile", sub: "u-gone", email: "gone@example.com", firstName: "Gwen" } }));
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("m13", "u-gone"), ...keys.memberGsi("m13", "u-gone"), type: "Membership", status: "active", sub: "u-gone", roles: ["parent"], email: "gone@example.com" } }));
    expect((await call("DELETE", "/me", "u-gone", { confirm: "DELETE" })).status).toBe(204);
    expect(last()).toMatchObject({ to: "gone@example.com", subject: "Your Teem Hub account was deleted" });
    expect(last().text).toContain("You're no longer on: Mail 13 Blue");
  });
});

describe("templates for site owners", () => {
  it("lists, previews and test-sends to the owner only", async () => {
    const list = await owner("GET", "/admin/emails");
    expect(list.status).toBe(200);
    expect(list.body.messages.filter((m: any) => m.live).map((m: any) => m.id)).toEqual(["invite", "clubInvite", "accountDeleted", "mfaReset", "weekly", "staffDigest", "packet", "availability", "dues", "payment", "announcement", "change", "feedAlert"]);
    const prev = await owner("GET", "/admin/emails/invite/preview");
    expect(prev.body).toMatchObject({ subject: expect.stringContaining("invited you"), html: expect.stringContaining("<!doctype html>") });
    expect((await owner("GET", "/admin/emails/changeText/preview")).status).toBe(400);
    expect((await owner("GET", "/admin/emails/weekly/preview")).body.html).toContain("Your week");
    expect((await owner("POST", "/admin/emails/clubInvite/test")).body).toEqual({ to: "owner@example.com" });
    expect(last().to).toBe("owner@example.com");
    expect((await call("GET", "/admin/emails", "u-par")).status).toBe(403);
    expect((await call("POST", "/admin/emails/invite/test", "u-par")).status).toBe(403);
  });
});

describe("sending pieces", () => {
  it("escapes what people type and writes the sender header safely", () => {
    const r = render("invite", { teamName: "<b>Tom</b> & Co", roles: ["parent"], email: "a@example.com", siteUrl: "https://x.test" });
    expect(r.html).toContain("&lt;b&gt;Tom&lt;/b&gt; &amp; Co");
    expect(r.html).not.toContain("<b>Tom</b>");
    expect(fromHeader('A5 "13" Tom via Teem Hub', "noreply@teemhub.net")).toBe('"A5 13 Tom via Teem Hub" <noreply@teemhub.net>');
    expect(fromHeader("Équipe via Teem Hub", "noreply@teemhub.net")).toMatch(/^=\?UTF-8\?B\?.+\?= <noreply@teemhub\.net>$/);
    expect(rolePhrase(["parent", "food"], "Ivy")).toBe("Ivy's parent or guardian and the food coordinator");
  });

  it("records the email as skipped where sending isn't set up", async () => {
    process.env.MAIL_TRANSPORT = "";
    try {
      expect((await owner("POST", "/teams/m13/invites", { email: "nomail@example.com", roles: ["parent"] })).status).toBe(201);
      expect((await invites()).find((i) => i.email === "nomail@example.com")).toMatchObject({ emailStatus: "skipped" });
      expect(memoryOutbox).toHaveLength(0);
    } finally { process.env.MAIL_TRANSPORT = "memory"; }
  });
});
