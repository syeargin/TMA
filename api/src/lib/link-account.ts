import { listGrants } from "./admin-lists.js";
import { keys, normEmail } from "./keys.js";
import { TABLE } from "./db.js";
import { inviteToMembershipItems, nameFromInvites, pendingInvites, writeInChunks } from "./invites.js";

/**
 * A new account's first records, once its email is verified: USER#<sub>/PROFILE, every waiting invite
 * turned into a membership (or club admin), and the admin lists applied once (listGrantsAt, R17).
 * All in one transaction per 100 actions, so a retry can't half-apply.
 * Used by the post-confirmation trigger, and by "Finish their sign-up" on the Members page when that trigger failed.
 */
export async function linkNewAccount(sub: string, rawEmail: string, at = new Date().toISOString()) {
  const email = normEmail(rawEmail);
  const grants = listGrants(sub, email, at);
  const { clubId, clubAdmin: isClubAdmin, platformAdmin: isPlatform } = grants;
  const invites = await pendingInvites(email);
  const name = nameFromInvites(invites);
  const items: Parameters<typeof writeInChunks>[0] = [
    { Put: { TableName: TABLE, Item: { ...keys.profile(sub), type: "UserProfile", sub, email, ...name, clubAdmin: isClubAdmin, createdAt: at, listGrantsAt: at } } }
  ];
  for (const Item of grants.items) items.push({ Put: { TableName: TABLE, Item } });
  // A club invite for the club they're already bootstrapped into would write the same item twice in one transaction.
  items.push(...inviteToMembershipItems(invites.filter((i) => !(isClubAdmin && i.SK === `CLUB#${clubId}`)), sub, email, at));
  await writeInChunks(items);
  return { invites: invites.length, clubAdmin: isClubAdmin, platformAdmin: isPlatform };
}
