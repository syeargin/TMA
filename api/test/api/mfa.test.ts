import { afterEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  AdminGetUserCommand, AdminSetUserMFAPreferenceCommand, CognitoIdentityProviderClient, UserNotFoundException
} from "@aws-sdk/client-cognito-identity-provider";
import { hasMfa, resetMfa, setMfaLookup } from "../../src/lib/mfa.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const env = { ...process.env };
afterEach(() => { cognito.reset(); process.env = { ...env }; setMfaLookup(); });

describe("two-step sign-in lookup", () => {
  it("without a user pool it passes only when MFA_CHECK=off", async () => {
    delete process.env.USER_POOL_ID;
    delete process.env.MFA_CHECK;
    expect(await hasMfa("u1")).toBe(false);
    process.env.MFA_CHECK = "off";
    expect(await hasMfa("u1")).toBe(true);
  });

  it("asks Cognito whether an authenticator app is on, and MFA_CHECK can't turn that off", async () => {
    process.env.USER_POOL_ID = "us-east-1_test";
    process.env.MFA_CHECK = "off";
    cognito.on(AdminGetUserCommand, { Username: "on" }).resolves({ Username: "on", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] });
    cognito.on(AdminGetUserCommand, { Username: "off" }).resolves({ Username: "off" });
    cognito.on(AdminGetUserCommand, { Username: "gone" }).rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
    expect(await hasMfa("on")).toBe(true);
    expect(await hasMfa("off")).toBe(false);
    expect(await hasMfa("gone")).toBe(false);
    expect(await hasMfa("")).toBe(false);
  });

  it("remembers a yes for a minute, never a no, and a reset forgets it", async () => {
    process.env.USER_POOL_ID = "us-east-1_test";
    cognito.on(AdminGetUserCommand).resolvesOnce({ UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] }).resolves({});
    expect(await hasMfa("u2")).toBe(true);
    expect(await hasMfa("u2")).toBe(true);
    expect(cognito.commandCalls(AdminGetUserCommand)).toHaveLength(1);
    await resetMfa("u2");
    expect(cognito.commandCalls(AdminSetUserMFAPreferenceCommand)[0].args[0].input).toEqual({
      UserPoolId: "us-east-1_test", Username: "u2", SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false }
    });
    expect(await hasMfa("u2")).toBe(false);
    expect(await hasMfa("u2")).toBe(false);
    expect(cognito.commandCalls(AdminGetUserCommand)).toHaveLength(3);
  });

  it("lets other errors through rather than guessing", async () => {
    process.env.USER_POOL_ID = "us-east-1_test";
    cognito.on(AdminGetUserCommand).rejects(new Error("throttled"));
    await expect(hasMfa("u3")).rejects.toThrow("throttled");
  });
});
