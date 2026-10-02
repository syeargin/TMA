import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { emailSet, keys } from "../../lib/keys.js";
import { acceptPendingInvites } from "../../lib/invites.js";
import { clubsOfTeams, DEFAULT_CLUB, getClubs, platformEmails } from "../../lib/clubs.js";
import { json, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { clean, getItem, now, putItem, queryAll, str } from "../util.js";

const nameSchema = z.object({ firstName: str(60).min(1, "Enter your first name."), lastName: str(60) });

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
    const name = { firstName: String(profile.firstName ?? ""), lastName: String(profile.lastName ?? "") };
    const accepted = await acceptPendingInvites(caller.sub, email, name.firstName ? name : undefined);

    const at = new Date().toISOString();
    const [adminItem, platformItem, memberships, adminOf] = await Promise.all([
      getItem(keys.clubAdmin(DEFAULT_CLUB(), caller.sub)),
      getItem(keys.platformAdmin(caller.sub)),
      queryAll({
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)",
        ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":t": "TEAM#" }
      }),
      queryAll({
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :c)",
        ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":c": "CLUB#" }
      })
    ]);
    const adminClubs = new Set(adminOf.map((a) => String(a.GSI1SK).slice(5)));
    // The default club's admins: configured by email, or made before admin items were indexed by person.
    if (adminItem || emailSet(process.env.CLUB_ADMIN_EMAILS).has(email)) {
      if (!adminItem?.GSI1PK) {
        await putItem({ ...(adminItem ?? { grantedBy: "bootstrap", at }), ...keys.clubAdmin(DEFAULT_CLUB(), caller.sub), ...keys.clubAdminGsi(DEFAULT_CLUB(), caller.sub), type: "ClubAdmin", clubId: DEFAULT_CLUB(), sub: caller.sub, email });
      }
      adminClubs.add(DEFAULT_CLUB());
    }
    let platformAdmin = !!platformItem;
    if (!platformAdmin && platformEmails().has(email)) {
      await putItem({ ...keys.platformAdmin(caller.sub), type: "PlatformAdmin", sub: caller.sub, email, grantedBy: "bootstrap", at });
      platformAdmin = true;
    }

    const active = memberships.filter((m) => m.status === "active");
    const teamClub = await clubsOfTeams(active.map((m) => String(m.GSI1SK).slice(5)));
    const clubs = await getClubs([...adminClubs, ...teamClub.values()]);

    // No name of their own yet: use one an admin set on a team, and keep it on the profile from now on.
    if (!name.firstName) {
      const named = memberships.find((m) => m.status === "active" && m.firstName);
      if (named) {
        name.firstName = String(named.firstName);
        name.lastName = String(named.lastName ?? "");
        await ddb.send(new UpdateCommand({
          TableName: TABLE, Key: keys.profile(caller.sub),
          UpdateExpression: "SET firstName = :f, lastName = :l",
          ConditionExpression: "attribute_not_exists(firstName) OR firstName = :empty",
          ExpressionAttributeValues: { ":f": name.firstName, ":l": name.lastName, ":empty": "" }
        })).catch((e) => { if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e; });
      }
    }

    return json(200, {
      sub: caller.sub,
      email,
      ...name,
      clubAdmin: adminClubs.size > 0 || platformAdmin,
      platformAdmin,
      acceptedInvites: accepted,
      /** Clubs you're in through a team or as an admin, with their colors. */
      clubs: [...clubs.values()].map((c) => ({ ...c, admin: platformAdmin || adminClubs.has(c.clubId) })),
      teams: active.map((m) => {
        const teamId = String(m.GSI1SK).slice(5);
        return { teamId, ...clean(m), clubId: teamClub.get(teamId) };
      })
    });
  });

  /** Set my own first and last name. Copied to every team I'm on (and clubs I run), so others see it. */
  r.on("PUT", "/me", async ({ caller, body }) => {
    const { firstName, lastName } = parseBody(nameSchema, body);
    const at = now();
    if (!(await getItem(keys.profile(caller.sub)))) {
      await putItem({ ...keys.profile(caller.sub), type: "UserProfile", sub: caller.sub, email: caller.username ?? "", clubAdmin: false, createdAt: at });
    }
    const set = (Key: Record<string, string>, cond?: string) => ddb.send(new UpdateCommand({
      TableName: TABLE, Key, ConditionExpression: cond,
      UpdateExpression: "SET firstName = :f, lastName = :l, updatedAt = :at",
      ExpressionAttributeValues: { ":f": firstName, ":l": lastName, ":at": at }
    }));
    await set(keys.profile(caller.sub));
    // Team memberships and club admin records both carry the name.
    const memberships = await queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :u",
      ExpressionAttributeValues: { ":u": `USER#${caller.sub}` },
      ProjectionExpression: "PK, SK"
    });
    for (const m of memberships) {
      try { await set({ PK: String(m.PK), SK: String(m.SK) }, "attribute_exists(PK)"); }
      catch (e) { if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e; }
    }
    return json(200, { firstName, lastName });
  });
}
