import { BatchGetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { acceptPendingInvites } from "../../lib/invites.js";
import { clubsOfTeams, DEFAULT_CLUB, getClubs } from "../../lib/clubs.js";
import { json, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { clean, getItem, now, putItem, queryAll, str } from "../util.js";
import { hasMfa } from "../../lib/mfa.js";
import { getControlsMany } from "../../lib/club-controls.js";
import { listGrants } from "../../lib/admin-lists.js";
import { verifiedEmail } from "../../lib/identity.js";
import type { Caller } from "../context.js";
import { PRIVACY_VERSION } from "../../shared/privacy.js";

/** Which of these teams are archived (from their entries in the club team lists). */
async function archivedTeams(teamClub: Map<string, string>): Promise<Set<string>> {
  const out = new Set<string>();
  const all = [...teamClub].map(([t, c]) => keys.teamDir(c, t));
  for (let i = 0; i < all.length; i += 100) {
    let Keys: Record<string, unknown>[] = all.slice(i, i + 100);
    for (let attempt = 0; Keys.length && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys, ProjectionExpression: "SK, archived" } } }));
      for (const d of res.Responses?.[TABLE] ?? []) if (d.archived) out.add(String(d.SK).slice(5));
      Keys = (res.UnprocessedKeys?.[TABLE]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  return out;
}

const nameSchema =z.object({ firstName: str(60).min(1, "Enter your first name."), lastName: str(60) });

/**
 * The person's profile, made now for accounts that don't have one (made before profiles existed, or if
 * the sign-up step didn't finish). Its email is only ever a Cognito-verified one (R5): an unverified or
 * missing email is saved as "" and grants nothing, no invites and no admin rights.
 */
async function ensureProfile(caller: Caller, tokenEmail = ""): Promise<Record<string, unknown>> {
  const existing = await getItem(keys.profile(caller.sub));
  if (existing) return existing;
  const email = await verifiedEmail(caller.username || caller.sub, tokenEmail);
  const profile = { ...keys.profile(caller.sub), type: "UserProfile", sub: caller.sub, email, clubAdmin: false, createdAt: now() };
  try {
    await putItem(profile, "attribute_not_exists(PK)");
  } catch (e) {
    // Two requests at once: keep whichever was saved first.
    if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    return (await getItem(keys.profile(caller.sub)))!;
  }
  return profile;
}

export function meRoutes(r: Router) {
  /** Who am I, which teams am I on, with what roles. Also accepts any invites waiting for my email. */
  r.on("GET", "/me", async ({ caller, event }) => {
    const tokenEmail = String(event.requestContext.authorizer.jwt.claims.email ?? "");
    let profile = await ensureProfile(caller, tokenEmail);
    // The email checked at sign-up, or Cognito's verified email for older accounts; "" if none is
    // verified, which matches no invites and no admin list.
    const email = String(profile.email ?? "");
    const name = { firstName: String(profile.firstName ?? ""), lastName: String(profile.lastName ?? "") };
    const accepted = email ? await acceptPendingInvites(caller.sub, email, name.firstName ? name : undefined) : 0;

    const at = new Date().toISOString();
    // R17: the admin lists apply once per person (sign-up sets listGrantsAt; older accounts get it here).
    if (!profile.listGrantsAt && email) {
      try {
        // Claim the one-time grant first, so two requests at once can't both apply it.
        await ddb.send(new UpdateCommand({
          TableName: TABLE, Key: keys.profile(caller.sub),
          UpdateExpression: "SET listGrantsAt = :at", ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(listGrantsAt)",
          ExpressionAttributeValues: { ":at": at }
        }));
        for (const item of listGrants(caller.sub, email, at).items) await putItem(item);
      } catch (e) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
      }
      profile = { ...profile, listGrantsAt: at };
    }
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
    // Default-club admin records made before they were indexed by person get the index now.
    if (adminItem) {
      if (!adminItem.GSI1PK) {
        await putItem({ ...adminItem, ...keys.clubAdminGsi(DEFAULT_CLUB(), caller.sub), clubId: DEFAULT_CLUB(), sub: caller.sub, email: adminItem.email ?? email });
      }
      adminClubs.add(DEFAULT_CLUB());
    }
    // Rights come only from stored records (R17).
    const platformAdmin = !!platformItem;

    const active = memberships.filter((m) => m.status === "active");
    const teamClub = await clubsOfTeams(active.map((m) => String(m.GSI1SK).slice(5)));
    const [clubs, archived, controls] = await Promise.all([getClubs([...adminClubs, ...teamClub.values()]), archivedTeams(teamClub), getControlsMany([...adminClubs, ...teamClub.values()])]);

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

    // Club admins and site owners need two-step sign-in before those rights work (R2).
    const mfaRequired = adminClubs.size > 0 || platformAdmin;
    const mfaOn = mfaRequired ? await hasMfa(caller.username) : undefined;

    return json(200, {
      sub: caller.sub,
      email,
      ...name,
      clubAdmin: adminClubs.size > 0 || platformAdmin,
      platformAdmin,
      /** required: club admin or site owner. enabled: only checked when required. */
      mfa: { required: mfaRequired, enabled: mfaOn },
      /** The privacy notice this person last accepted; the site asks again when the version changes (R4). */
      privacy: { version: PRIVACY_VERSION, accepted: profile.privacyVersion === PRIVACY_VERSION, acceptedAt: profile.privacyAt },
      acceptedInvites: accepted,
      /** Clubs you're in through a team or as an admin, with their colors. */
      clubs: [...clubs.values()].map((c) => ({ ...c, admin: platformAdmin || adminClubs.has(c.clubId), ...(controls.get(c.clubId)?.status === "inactive" ? { inactive: true } : {}) })),
      teams: active.map((m) => {
        const teamId = String(m.GSI1SK).slice(5);
        const clubId = teamClub.get(teamId);
        const inactive = !!clubId && controls.get(clubId)?.status === "inactive";
        return { teamId, ...clean(m), clubId, ...(archived.has(teamId) ? { archived: true } : {}), ...(inactive ? { clubInactive: true } : {}) };
      })
    });
  });

  /** Set my own first and last name. Copied to every team I'm on (and clubs I run), so others see it. */
  r.on("PUT", "/me", async ({ caller, body }) => {
    const { firstName, lastName } = parseBody(nameSchema, body);
    const at = now();
    await ensureProfile(caller);
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
