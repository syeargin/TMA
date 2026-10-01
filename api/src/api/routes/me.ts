import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { emailSet, keys } from "../../lib/keys.js";
import { acceptPendingInvites } from "../../lib/invites.js";
import { CLUB_ID } from "../context.js";
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
      clubId: CLUB_ID(),
      clubAdmin,
      acceptedInvites: accepted,
      teams: memberships
        .filter((m) => m.status === "active")
        .map((m) => ({ teamId: String(m.GSI1SK).slice(5), ...clean(m) }))
    });
  });

  /** Set my own first and last name. Copied to every team I'm on, so teammates see it. */
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
    const memberships = await queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)",
      ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":t": "TEAM#" },
      ProjectionExpression: "PK, SK"
    });
    for (const m of memberships) {
      try { await set({ PK: String(m.PK), SK: String(m.SK) }, "attribute_exists(PK)"); }
      catch (e) { if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e; }
    }
    return json(200, { firstName, lastName });
  });
}
