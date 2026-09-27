import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

process.env.TABLE_NAME = "TeamHub-test";
process.env.CLUB_ID = "a5";
process.env.CLUB_ADMIN_EMAILS = "Admin@Example.com, other@example.com";

const { handler: preSignUp, NOT_INVITED } = await import("../src/auth-triggers/pre-sign-up.js");
const { handler: postConfirmation } = await import("../src/auth-triggers/post-confirmation.js");

const ddbMock = mockClient(DynamoDBDocumentClient);
const noop = () => {};
const ctx = {} as any;

const preEvent = (email: string, triggerSource = "PreSignUp_SignUp") => ({
  triggerSource, request: { userAttributes: { email } }, response: {}
}) as any;

const postEvent = (email: string, sub = "sub-123", triggerSource = "PostConfirmation_ConfirmSignUp") => ({
  triggerSource, request: { userAttributes: { email, sub } }, response: {}
}) as any;

beforeEach(() => ddbMock.reset());

describe("pre-sign-up", () => {
  it("allows an invited email, matching case-insensitively", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: "INVITE#parent@example.com", SK: "TEAM#a5-13tom" }] });
    await expect(preSignUp(preEvent("  Parent@Example.com "), ctx, noop)).resolves.toBeDefined();
    const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ExpressionAttributeValues?.[":pk"]).toBe("INVITE#parent@example.com");
  });

  it("rejects an email with no invite", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(preSignUp(preEvent("stranger@example.com"), ctx, noop)).rejects.toThrow(NOT_INVITED);
  });

  it("allows club admins without an invite and without a lookup", async () => {
    await expect(preSignUp(preEvent("admin@example.com"), ctx, noop)).resolves.toBeDefined();
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("ignores admin-created users", async () => {
    await expect(preSignUp(preEvent("x@example.com", "PreSignUp_AdminCreateUser"), ctx, noop)).resolves.toBeDefined();
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe("post-confirmation", () => {
  it("turns each invite into a membership and deletes the invite", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { PK: "INVITE#parent@example.com", SK: "TEAM#a5-13tom", person: "parent:p12:1", pid: "p12", roles: ["parent"], invitedBy: "sub-admin" },
        { PK: "INVITE#parent@example.com", SK: "TEAM#a5-14-kate", roles: ["coach"] }
      ]
    });
    ddbMock.on(TransactWriteCommand).resolves({});
    await postConfirmation(postEvent("Parent@example.com"), ctx, noop);

    const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    const puts = tx.filter((t) => t.Put).map((t) => t.Put!.Item!);
    const dels = tx.filter((t) => t.Delete).map((t) => t.Delete!.Key!);

    expect(puts.find((i) => i.SK === "PROFILE")).toMatchObject({ PK: "USER#sub-123", email: "parent@example.com", clubAdmin: false });
    expect(puts.find((i) => i.PK === "TEAM#a5-13tom")).toMatchObject({
      SK: "MEMBER#sub-123", GSI1PK: "USER#sub-123", GSI1SK: "TEAM#a5-13tom",
      status: "active", person: "parent:p12:1", pid: "p12", roles: ["parent"]
    });
    expect(puts.find((i) => i.PK === "TEAM#a5-14-kate")).toMatchObject({ roles: ["coach"] });
    expect(dels).toEqual([
      { PK: "INVITE#parent@example.com", SK: "TEAM#a5-13tom" },
      { PK: "INVITE#parent@example.com", SK: "TEAM#a5-14-kate" }
    ]);
    expect(puts.some((i) => String(i.PK).startsWith("CLUB#"))).toBe(false);
  });

  it("records club admins", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    await postConfirmation(postEvent("admin@example.com", "sub-admin"), ctx, noop);
    const puts = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.map((t) => t.Put!.Item!);
    expect(puts).toEqual(expect.arrayContaining([
      expect.objectContaining({ PK: "CLUB#a5", SK: "ADMIN#sub-admin", type: "ClubAdmin" }),
      expect.objectContaining({ PK: "USER#sub-admin", SK: "PROFILE", clubAdmin: true })
    ]));
  });

  it("follows pagination and splits large transactions at 100 actions", async () => {
    const page = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ PK: "INVITE#p@example.com", SK: `TEAM#t${start + i}` }));
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: page(40, 0), LastEvaluatedKey: { PK: "x", SK: "y" } })
      .resolvesOnce({ Items: page(20, 40) });
    ddbMock.on(TransactWriteCommand).resolves({});
    await postConfirmation(postEvent("p@example.com"), ctx, noop);
    const calls = ddbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!.length);
    expect(calls).toEqual([100, 21]); // 1 profile + 60 × (put + delete)
  });

  it("does nothing for forgot-password confirmations", async () => {
    await postConfirmation(postEvent("p@example.com", "s", "PostConfirmation_ConfirmForgotPassword"), ctx, noop);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});
