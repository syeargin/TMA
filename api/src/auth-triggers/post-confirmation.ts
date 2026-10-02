import type { PostConfirmationTriggerHandler } from "aws-lambda";
import { DEFAULT_CLUB, platformEmails } from "../lib/clubs.js";
import { emailSet, keys, normEmail } from "../lib/keys.js";
import { TABLE } from "../lib/db.js";
import { inviteToMembershipItems, nameFromInvites, pendingInvites, writeInChunks } from "../lib/invites.js";

/**
 * Cognito post-confirmation trigger. Runs once the person has verified their email.
 *  - Writes USER#<sub>/PROFILE.
 *  - Turns every INVITE#<email>/TEAM#<t> into TEAM#<t>/MEMBER#<sub> (roles, family) and deletes the invite.
 *  - Turns every INVITE#<email>/CLUB#<c> into CLUB#<c>/ADMIN#<sub>.
 *  - Emails in CLUB_ADMIN_EMAILS also get CLUB#<default club>/ADMIN#<sub>; PLATFORM_ADMIN_EMAILS get PLATFORM/ADMIN#<sub>.
 * All writes for one person go in one transaction (chunked at 100 actions), so a retry can't half-apply.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;

  const sub = event.request.userAttributes.sub;
  const email = normEmail(event.request.userAttributes.email ?? "");
  const now = new Date().toISOString();
  const clubId = DEFAULT_CLUB();
  const isPlatform = platformEmails().has(email);
  const isClubAdmin = emailSet(process.env.CLUB_ADMIN_EMAILS).has(email);

  const invites = await pendingInvites(email);
  const name = nameFromInvites(invites);
  const items: Parameters<typeof writeInChunks>[0] = [
    { Put: { TableName: TABLE, Item: { ...keys.profile(sub), type: "UserProfile", sub, email, ...name, clubAdmin: isClubAdmin, createdAt: now } } }
  ];
  if (isClubAdmin) {
    items.push({ Put: { TableName: TABLE, Item: { ...keys.clubAdmin(clubId, sub), ...keys.clubAdminGsi(clubId, sub), type: "ClubAdmin", clubId, sub, email, grantedBy: "bootstrap", at: now } } });
  }
  if (isPlatform) items.push({ Put: { TableName: TABLE, Item: { ...keys.platformAdmin(sub), type: "PlatformAdmin", sub, email, grantedBy: "bootstrap", at: now } } });
  // A club invite for the club they're already bootstrapped into would write the same item twice in one transaction.
  items.push(...inviteToMembershipItems(invites.filter((i) => !(isClubAdmin && i.SK === `CLUB#${clubId}`)), sub, email, now));
  await writeInChunks(items);

  console.log(JSON.stringify({ msg: "linked account", sub, invites: invites.length, clubAdmin: isClubAdmin, platformAdmin: isPlatform }));
  return event;
};
