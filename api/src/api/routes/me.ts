import { emailSet, keys } from "../../lib/keys.js";
import { acceptPendingInvites } from "../../lib/invites.js";
import { CLUB_ID } from "../context.js";
import { json } from "../http.js";
import type { Router } from "../router.js";
import { clean, getItem, putItem, queryAll } from "../util.js";

export function meRoutes(r: Router) {
  /** Who am I, which teams am I on, with what roles. Also accepts any invites waiting for my email. */
  r.on("GET", "/me", async ({ caller, event }) => {
    let profile = await getItem(keys.profile(caller.sub));
    const tokenEmail = String(event.requestContext.authorizer.jwt.claims.email ?? caller.username ?? "").toLowerCase();
    if (!profile) {
      // Accounts created before the profile item existed: create it now.
      profile = { ...keys.profile(caller.sub), type: "UserProfile", sub: caller.sub, email: tokenEmail, clubAdmin: false, createdAt: new Date().toISOString() };
      await putItem(profile);
    }
    const email = String(profile.email ?? tokenEmail);
    const accepted = await acceptPendingInvites(caller.sub, email);

    const [adminItem, memberships] = await Promise.all([
      getItem(keys.clubAdmin(CLUB_ID(), caller.sub)),
      queryAll({
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)",
        ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":t": "TEAM#" }
      })
    ]);
    // A configured club-admin email that signed up before the admin item existed.
    let clubAdmin = !!adminItem;
    if (!clubAdmin && emailSet(process.env.CLUB_ADMIN_EMAILS).has(email)) {
      await putItem({ ...keys.clubAdmin(CLUB_ID(), caller.sub), type: "ClubAdmin", sub: caller.sub, email, grantedBy: "bootstrap", at: new Date().toISOString() });
      clubAdmin = true;
    }

    return json(200, {
      sub: caller.sub,
      email,
      clubId: CLUB_ID(),
      clubAdmin,
      acceptedInvites: accepted,
      teams: memberships
        .filter((m) => m.status === "active")
        .map((m) => ({ teamId: String(m.GSI1SK).slice(5), ...clean(m) }))
    });
  });
}
