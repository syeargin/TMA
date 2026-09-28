import type { PostConfirmationTriggerHandler } from "aws-lambda";
import { emailSet, keys, normEmail } from "../lib/keys.js";
import { TABLE } from "../lib/db.js";
import { inviteToMembershipItems, pendingInvites, writeInChunks } from "../lib/invites.js";

/**
 * Cognito post-confirmation trigger. Runs once the person has verified their email.
 *  - Writes USER#<sub>/PROFILE.
 *  - Turns every INVITE#<email>/TEAM#<t> into TEAM#<t>/MEMBER#<sub> (roles, family) and deletes the invite.
 *  - Emails in CLUB_ADMIN_EMAILS also get CLUB#<club>/ADMIN#<sub>.
 * All writes for one person go in one transaction (chunked at 100 actions), so a retry can't half-apply.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;

  const sub = event.request.userAttributes.sub;
  const email = normEmail(event.request.userAttributes.email ?? "");
  const now = new Date().toISOString();
  const clubId = process.env.CLUB_ID ?? "a5";
  const isClubAdmin = emailSet(process.env.CLUB_ADMIN_EMAILS).has(email);

  const invites = await pendingInvites(email);
  const items: Parameters<typeof writeInChunks>[0] = [
    { Put: { TableName: TABLE, Item: { ...keys.profile(sub), type: "UserProfile", sub, email, clubAdmin: isClubAdmin, createdAt: now } } }
  ];
  if (isClubAdmin) {
    items.push({ Put: { TableName: TABLE, Item: { ...keys.clubAdmin(clubId, sub), type: "ClubAdmin", sub, email, grantedBy: "bootstrap", at: now } } });
  }
  items.push(...inviteToMembershipItems(invites, sub, email, now));
  await writeInChunks(items);

  console.log(JSON.stringify({ msg: "linked account", sub, teams: invites.length, clubAdmin: isClubAdmin }));
  return event;
};
