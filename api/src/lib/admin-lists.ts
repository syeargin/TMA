import { DEFAULT_CLUB, platformEmails } from "./clubs.js";
import { emailSet, keys } from "./keys.js";

/**
 * The deploy settings' admin lists (R17): ClubAdminEmails make someone an admin of the default club,
 * PlatformAdminEmails make them a site owner. They're applied once per person, when they sign up (or,
 * for accounts made before this, on their first visit), and the profile records that with listGrantsAt.
 * After that only the stored records count, so removing someone's admin rights sticks even if their
 * email is still on a list. The email must be a verified one.
 */
export function listGrants(sub: string, email: string, at: string) {
  const clubId = DEFAULT_CLUB();
  const clubAdmin = !!email && emailSet(process.env.CLUB_ADMIN_EMAILS).has(email);
  const platformAdmin = !!email && platformEmails().has(email);
  const items: Record<string, unknown>[] = [];
  if (clubAdmin) items.push({ ...keys.clubAdmin(clubId, sub), ...keys.clubAdminGsi(clubId, sub), type: "ClubAdmin", clubId, sub, email, grantedBy: "bootstrap", at });
  if (platformAdmin) items.push({ ...keys.platformAdmin(sub), type: "PlatformAdmin", sub, email, grantedBy: "bootstrap", at });
  return { clubAdmin, platformAdmin, clubId, items };
}
