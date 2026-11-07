import { AdminDeleteUserCommand, CognitoIdentityProviderClient, ListUsersCommand, UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";

let client: CognitoIdentityProviderClient | undefined;
export const cognito = () => (client ??= new CognitoIdentityProviderClient({}));
export const poolId = () => process.env.USER_POOL_ID ?? "";

/** Removes a sign-in account (Delete my account, R4). Gone already is fine; without a pool (tests) it's a no-op. */
export async function deleteSignIn(username: string): Promise<void> {
  if (!poolId()) return;
  try {
    await cognito().send(new AdminDeleteUserCommand({ UserPoolId: poolId(), Username: username }));
  } catch (e) {
    if (!(e instanceof UserNotFoundException)) throw e;
  }
}

export type SignIn = { username: string; sub: string; status: string; createdAt?: string };

/** The sign-in for an email, if anyone has started signing up with it (null without a pool: tests mock this). */
export async function findSignIn(email: string): Promise<SignIn | null> {
  if (!poolId()) return null;
  const r = await cognito().send(new ListUsersCommand({ UserPoolId: poolId(), Filter: `email = "${email.replace(/["\\]/g, "")}"`, Limit: 2 }));
  const u = r.Users?.[0];
  if (!u?.Username) return null;
  const sub = u.Attributes?.find((a) => a.Name === "sub")?.Value ?? u.Username;
  return { username: u.Username, sub, status: String(u.UserStatus ?? ""), createdAt: u.UserCreateDate?.toISOString() };
}
