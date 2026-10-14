import { afterEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { AdminGetUserCommand, CognitoIdentityProviderClient, UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";
import { verifiedEmail } from "../../src/lib/identity.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const env = { ...process.env };
afterEach(() => { cognito.reset(); process.env = { ...env }; });

const attrs = (email: string, verified: string) => ({ UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: verified }] });

describe("verified email lookup (R5)", () => {
  it("without a user pool it trusts the token only when EMAIL_CHECK=off", async () => {
    delete process.env.USER_POOL_ID;
    delete process.env.EMAIL_CHECK;
    expect(await verifiedEmail("u1", "A@Example.com")).toBe("");
    process.env.EMAIL_CHECK = "off";
    expect(await verifiedEmail("u1", " A@Example.com ")).toBe("a@example.com");
  });

  it("asks Cognito, returns only a verified email, and ignores the token and EMAIL_CHECK", async () => {
    process.env.USER_POOL_ID = "us-east-1_test";
    process.env.EMAIL_CHECK = "off";
    cognito.on(AdminGetUserCommand, { Username: "yes" }).resolves(attrs("Yes@Example.com", "true"));
    cognito.on(AdminGetUserCommand, { Username: "no" }).resolves(attrs("no@example.com", "false"));
    cognito.on(AdminGetUserCommand, { Username: "gone" }).rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
    expect(await verifiedEmail("yes", "owner@example.com")).toBe("yes@example.com");
    expect(await verifiedEmail("no", "no@example.com")).toBe("");
    expect(await verifiedEmail("gone", "x@example.com")).toBe("");
    expect(await verifiedEmail("", "x@example.com")).toBe("");
  });

  it("lets other errors through rather than guessing", async () => {
    process.env.USER_POOL_ID = "us-east-1_test";
    cognito.on(AdminGetUserCommand).rejects(new Error("throttled"));
    await expect(verifiedEmail("u3")).rejects.toThrow("throttled");
  });
});
