import { AdminGetUserCommand, AdminSetUserMFAPreferenceCommand, UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";
import { cognito, poolId } from "./cognito.js";

/**
 * Two-step sign-in (risk R2). The user pool has MFA set to OPTIONAL with authenticator apps only:
 * once someone turns it on, Cognito asks for a code at every sign-in. So "this person has an
 * authenticator app turned on" means every session they have was opened with a code, and club-admin
 * and site-owner rights are granted only then.
 *
 * Access tokens on the Lite tier can't carry an "mfa" claim, so the API asks Cognito.
 */

type Lookup = (username: string) => Promise<boolean>;


async function fromCognito(username: string): Promise<boolean> {
  try {
    const u = await cognito().send(new AdminGetUserCommand({ UserPoolId: poolId(), Username: username }));
    return (u.UserMFASettingList ?? []).includes("SOFTWARE_TOKEN_MFA");
  } catch (e) {
    if (e instanceof UserNotFoundException) return false;
    throw e;
  }
}

/**
 * Without a user pool (tests, the local preview) the check passes only when MFA_CHECK=off.
 * In AWS USER_POOL_ID is always set, so the switch can't turn the check off there.
 */
function defaultLookup(username: string): Promise<boolean> {
  if (poolId()) return fromCognito(username);
  return Promise.resolve(process.env.MFA_CHECK === "off");
}

let lookup: Lookup = defaultLookup;
/** Tests replace the lookup; pass nothing to restore it. */
export function setMfaLookup(fn?: Lookup) { lookup = fn ?? defaultLookup; cache.clear(); }

// Only "yes" answers are cached, briefly: a reset takes effect within a minute, and someone who
// has just turned it on doesn't wait at all.
const TTL_MS = 60_000;
const cache = new Map<string, number>();

export async function hasMfa(username: string): Promise<boolean> {
  if (!username) return false;
  const until = cache.get(username);
  if (until && until > Date.now()) return true;
  const on = await lookup(username);
  if (on) cache.set(username, Date.now() + TTL_MS); else cache.delete(username);
  return on;
}

/** Turns off someone's authenticator app so they can set it up again (a lost phone). */
export async function resetMfa(username: string): Promise<void> {
  cache.delete(username);
  if (!poolId()) return;
  await cognito().send(new AdminSetUserMFAPreferenceCommand({
    UserPoolId: poolId(), Username: username,
    SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false }
  }));
}

export const MFA_MESSAGE = "Turn on two-step sign-in to use club admin and site owner tools. You'll find it on Your teams, under Two-step sign-in.";
