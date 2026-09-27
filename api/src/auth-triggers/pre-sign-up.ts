import type { PreSignUpTriggerHandler } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/db.js";
import { emailSet, keys, normEmail } from "../lib/keys.js";

/** Message shown on the sign-up screen (Cognito prefixes it; the page strips the prefix). */
export const NOT_INVITED =
  "This email hasn't been invited yet. Ask your team coordinator to send an invite to this address.";

/**
 * Cognito pre-sign-up trigger. Allows sign-up only when the email has at least one
 * pending team invite, or is listed as a club admin in CLUB_ADMIN_EMAILS.
 * Email verification is still required afterwards (autoConfirmUser stays false).
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  if (event.triggerSource !== "PreSignUp_SignUp") return event;

  const email = normEmail(event.request.userAttributes.email ?? "");
  if (!email) throw new Error(NOT_INVITED);

  if (emailSet(process.env.CLUB_ADMIN_EMAILS).has(email)) return event;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :team)",
    ExpressionAttributeValues: { ":pk": keys.invitePrefix(email), ":team": "TEAM#" },
    Limit: 1
  }));

  if (!res.Items?.length) throw new Error(NOT_INVITED);
  return event;
};
