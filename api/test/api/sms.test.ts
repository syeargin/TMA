import { afterEach, beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-sms";
delete process.env.SMS_ORIGINATION;
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { usPhone } = await import("../../src/api/routes/sms.js");
const { SMS } = await import("../../src/shared/privacy.js");
const { GetCommand, PutCommand } = await import("@aws-sdk/lib-dynamodb");

type Res = { status: number; body: any };
async function call(method: string, path: string, sub: string, body?: unknown, email?: string): Promise<Res> {
  const r = await handler(event(method, path, sub, body, email));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const owner = (m: string, p: string, b?: unknown) => call(m, p, "u-owner", b, "owner@example.com");
const parent = (m: string, p: string, b?: unknown) => call(m, p, "u-par", b, "par@example.com");
const agree = (phone: string) => ({ phone, agree: true, consentVersion: SMS.consentVersion });
const profile = async (sub: string) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.profile(sub) }))).Item!;

beforeAll(async () => {
  await freshTable();
  expect((await owner("GET", "/me")).body.platformAdmin).toBe(true);
  expect((await parent("GET", "/me")).status).toBe(200);
});
afterEach(() => { delete process.env.SMS_ORIGINATION; });

describe("text alerts opt-in", () => {
  it("is only for site owners until texting is live", async () => {
    expect((await parent("GET", "/me/sms")).body).toMatchObject({ live: false, allowed: false, status: "off", consent: { text: SMS.consent } });
    expect((await parent("PUT", "/me/sms", agree("555 555 0123"))).status).toBe(403);
    expect((await owner("GET", "/me/sms")).body).toMatchObject({ live: false, allowed: true, status: "off" });
  });

  it("needs a US mobile number, the box ticked, and the current wording", async () => {
    expect((await owner("PUT", "/me/sms", agree("12345"))).body.message).toMatch(/US mobile number/);
    expect((await owner("PUT", "/me/sms", { phone: "(614) 555-0123", agree: false, consentVersion: SMS.consentVersion })).status).toBe(400);
    expect((await owner("PUT", "/me/sms", { ...agree("(614) 555-0123"), consentVersion: "2020-01-01" })).status).toBe(403);
  });

  it("keeps the number and a consent record with the exact words agreed to", async () => {
    const r = await owner("PUT", "/me/sms", agree("+1 (614) 555-0123"));
    expect(r.body).toMatchObject({ live: false, status: "pending", phone: "(614) 555-0123" });
    const sms = (await profile("u-owner")).sms;
    expect(sms).toMatchObject({ phone: "+16145550123", status: "pending", consent: { version: SMS.consentVersion, text: SMS.consent, method: "web form (Account page)", ip: "127.0.0.1" } });
    expect((await owner("GET", "/me/export")).body.account.sms.phone).toBe("+16145550123");
  });

  it("turns off: the number goes, the opt-out is kept", async () => {
    expect((await owner("DELETE", "/me/sms")).body).toEqual({ status: "off" });
    const sms = (await profile("u-owner")).sms;
    expect(sms.phone).toBeUndefined();
    expect(sms).toMatchObject({ status: "off", offBy: "web" });
    expect((await owner("GET", "/me/sms")).body.status).toBe("off");
  });

  it("is open to anyone on a team once the stack has a number to send from", async () => {
    process.env.SMS_ORIGINATION = "+18885550100";
    // Not on any team yet: nothing to text about.
    expect((await parent("GET", "/me/sms")).body).toMatchObject({ live: true, allowed: false });
    expect((await owner("POST", "/clubs", { clubId: "sc", name: "SMS Club" })).status).toBe(201);
    expect((await owner("POST", "/teams", { clubId: "sc", teamId: "sc-1", name: "SC 1" })).status).toBe(201);
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("sc-1", "u-par"), ...keys.memberGsi("sc-1", "u-par"), type: "Membership", status: "active", sub: "u-par", roles: ["parent"] } }));
    expect((await parent("GET", "/me/sms")).body).toMatchObject({ live: true, allowed: true });
    expect((await parent("PUT", "/me/sms", agree("614.555.0199"))).body).toMatchObject({ live: true, status: "pending", phone: "(614) 555-0199" });
  });
});

describe("US phone numbers", () => {
  it("normalizes the usual ways of writing one, and refuses the rest", () => {
    for (const s of ["6145550123", "(614) 555-0123", "614.555.0123", "+1 614 555 0123", "1-614-555-0123"]) expect(usPhone(s)).toBe("+16145550123");
    for (const s of ["555-0123", "+44 20 7946 0958", "(014) 555-0123", "614 155 0123", ""]) expect(usPhone(s)).toBeNull();
  });
});
