import { AdminGetUserCommand, UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";
import { cognito, poolId } from "./cognito.js";
import { normEmail } from "./keys.js";

/**
 * A person's email, only if Cognito says it's verified (R5). Used whenever the API has no profile for
 * someone: it never trusts an email from a token, and an unverified address grants nothing (no invites,
 * no admin rights). Since the pool requires verification before an email change takes effect, the
 * verified address is the one they signed up with, or one they've proven they own.
 */
type Lookup = (username: string, tokenEmail: string) => Promise<string>;

async function fromCognito(username: string): Promise<string> {
  try {
    const u = await cognito().send(new AdminGetUserCommand({ UserPoolId: poolId(), Username: username }));
    const attr = (n: string) => u.UserAttributes?.find((a) => a.Name === n)?.Value ?? "";
    return attr("email_verified") === "true" ? normEmail(attr("email")) : "";
  } catch (e) {
    if (e instanceof UserNotFoundException) return "";
    throw e;
  }
}

/** Without a user pool (tests, the local preview) the token's email is used only when EMAIL_CHECK=off. */
function defaultLookup(username: string, tokenEmail: string): Promise<string> {
  if (poolId()) return fromCognito(username);
  return Promise.resolve(process.env.EMAIL_CHECK === "off" ? normEmail(tokenEmail) : "");
}

let lookup: Lookup = defaultLookup;
/** Tests replace the lookup; pass nothing to restore it. */
export function setVerifiedEmailLookup(fn?: Lookup) { lookup = fn ?? defaultLookup; }

export function verifiedEmail(username: string, tokenEmail = ""): Promise<string> {
  return username ? lookup(username, tokenEmail) : Promise.resolve("");
}
