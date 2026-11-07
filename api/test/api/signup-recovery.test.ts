import { beforeAll, describe, expect, it, vi } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-signup";
process.env.MAIL_TRANSPORT = "memory";
process.env.MFA_CHECK = "off";
process.env.SITE_URL = "https://teemhub.net";

// The sign-in system, faked: sign-ins by email, and what was deleted.
const signIns = new Map<string, { username: string; sub: string; status: string }>();
const deleted: string[] = [];
vi.mock("../../src/lib/cognito.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/cognito.js")>()),
  findSignIn: async (email: string) => signIns.get(email) ?? null,
  deleteSignIn: async (username: string) => { deleted.push(username); }
}));

const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { memoryOutbox } = await import("../../src/lib/mail/outbox.js");
const { PutCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");

async function call(method: string, path: string, sub: string, body?: unknown) {
  const r = await handler(event(method, path, sub, body));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const get = async (k: { PK: string; SK: string }) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: k }))).Item;
const T = "t13", ADMIN = "u-admin", PARENT = "u-parent";

beforeAll(async () => {
  await freshTable();
  await put({ ...keys.settings(T), teamName: "A5 13 Tom" });
  await put({ ...keys.member(T, ADMIN), ...keys.memberGsi(T, ADMIN), type: "Membership", status: "active", sub: ADMIN, roles: ["admin"], email: "admin@example.com", pid: "" });
  await put({ ...keys.member(T, PARENT), ...keys.memberGsi(T, PARENT), type: "Membership", status: "active", sub: PARENT, roles: ["parent"], email: "p@example.com", pid: "" });
  for (const email of ["vo@example.com", "linked@example.com", "new@example.com"]) {
    expect((await call("POST", `/teams/${T}/invites`, ADMIN, { email, roles: ["parent"], firstName: "Vitor", sendEmail: false })).status).toBe(201);
  }
}, 60_000);

describe("trouble signing up", () => {
  it("resets a sign-up that never got its emailed code, and emails the invite again", async () => {
    signIns.set("vo@example.com", { username: "cog-vo", sub: "u-vo", status: "UNCONFIRMED" });
    expect((await call("GET", `/teams/${T}/invites/vo@example.com/signup`, ADMIN)).body.state).toBe("unfinished");
    memoryOutbox.length = 0;
    const r = await call("POST", `/teams/${T}/invites/vo@example.com/signup`, ADMIN);
    expect(r.body).toEqual({ done: "reset", emailed: true });
    expect(deleted).toEqual(["cog-vo"]);
    expect(memoryOutbox.filter((m) => m.to === "vo@example.com").length).toBe(1);
    expect(await get(keys.invite("vo@example.com", T))).toBeTruthy();
  });

  it("finishes an account whose email was verified but never set up", async () => {
    signIns.set("linked@example.com", { username: "cog-li", sub: "u-li", status: "CONFIRMED" });
    expect((await call("GET", `/teams/${T}/invites/linked@example.com/signup`, ADMIN)).body.state).toBe("unlinked");
    expect((await call("POST", `/teams/${T}/invites/linked@example.com/signup`, ADMIN)).body).toEqual({ done: "linked" });
    expect((await get(keys.profile("u-li")))?.email).toBe("linked@example.com");
    expect((await get(keys.member(T, "u-li")))?.status).toBe("active");
    expect(await get(keys.invite("linked@example.com", T))).toBeUndefined();
  });

  it("changes nothing when there's nothing stuck, and only for people who manage invites", async () => {
    expect((await call("GET", `/teams/${T}/invites/new@example.com/signup`, ADMIN)).body.state).toBe("none");
    expect((await call("POST", `/teams/${T}/invites/new@example.com/signup`, ADMIN)).status).toBe(409);
    signIns.set("new@example.com", { username: "cog-new", sub: "u-li", status: "CONFIRMED" });
    expect((await call("GET", `/teams/${T}/invites/new@example.com/signup`, ADMIN)).body.state).toBe("ready");
    expect((await call("POST", `/teams/${T}/invites/new@example.com/signup`, ADMIN)).status).toBe(409);
    expect((await call("POST", `/teams/${T}/invites/new@example.com/signup`, PARENT)).status).toBe(403);
    expect((await call("GET", `/teams/${T}/invites/gone@example.com/signup`, ADMIN)).status).toBe(404);
    expect(deleted).toEqual(["cog-vo"]);
  });
});
