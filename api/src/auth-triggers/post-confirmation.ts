import type { PostConfirmationTriggerHandler } from "aws-lambda";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/db.js";
import { emailSet, keys, normEmail } from "../lib/keys.js";

type Invite = {
  PK: string; SK: string;
  teamId?: string; person?: string; pid?: string; roles?: string[]; invitedBy?: string;
};

/**
 * Cognito post-confirmation trigger. Runs once the person has verified their email.
 *  - Writes USER#<sub>/PROFILE.
 *  - Turns every INVITE#<email>/TEAM#<t> into TEAM#<t>/MEMBER#<sub> (roles, family) and deletes the invite.
 *  - Emails in CLUB_ADMIN_EMAILS also get CLUB#<club>/ADMIN#<sub>.
 * All writes for one person go in a single transaction, so a retry can't half-apply.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;

  const sub = event.request.userAttributes.sub;
  const email = normEmail(event.request.userAttributes.email ?? "");
  const now = new Date().toISOString();
  const clubId = process.env.CLUB_ID ?? "a5";
  const isClubAdmin = emailSet(process.env.CLUB_ADMIN_EMAILS).has(email);

  const invites: Invite[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :team)",
      ExpressionAttributeValues: { ":pk": keys.invitePrefix(email), ":team": "TEAM#" },
      ExclusiveStartKey: startKey
    }));
    invites.push(...((res.Items ?? []) as Invite[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
    { Put: { TableName: TABLE, Item: { ...keys.profile(sub), type: "UserProfile", email, clubAdmin: isClubAdmin, createdAt: now } } }
  ];

  if (isClubAdmin) {
    items.push({ Put: { TableName: TABLE, Item: { ...keys.clubAdmin(clubId, sub), type: "ClubAdmin", email, grantedBy: "bootstrap", at: now } } });
  }

  for (const inv of invites) {
    const teamId = inv.teamId ?? inv.SK.slice("TEAM#".length);
    items.push({
      Put: {
        TableName: TABLE,
        Item: {
          ...keys.member(teamId, sub), type: "Membership", status: "active", email,
          person: inv.person ?? "", pid: inv.pid ?? "", roles: inv.roles ?? ["parent"],
          invitedBy: inv.invitedBy ?? "", at: now
        }
      }
    });
    items.push({ Delete: { TableName: TABLE, Key: { PK: inv.PK, SK: inv.SK } } });
  }

  // DynamoDB transactions hold up to 100 actions; 2 per invite leaves room for ~48 teams.
  for (let i = 0; i < items.length; i += 100) {
    await ddb.send(new TransactWriteCommand({ TransactItems: items.slice(i, i + 100) }));
  }

  console.log(JSON.stringify({ msg: "linked account", sub, teams: invites.length, clubAdmin: isClubAdmin }));
  return event;
};
