import { AdminDeleteUserCommand, CognitoIdentityProviderClient, UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";

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
