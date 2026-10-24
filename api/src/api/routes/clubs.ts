import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { DEFAULT_COLORS, getClub, getClubs, toClub } from "../../lib/clubs.js";
import { getControls, getControlsMany, publicControls } from "../../lib/club-controls.js";
import { ddb, TABLE } from "../../lib/db.js";
import { keys, normEmail } from "../../lib/keys.js";
import { isPlatformAdmin, loadClubAccess, requirePlatformAdmin } from "../context.js";
import { hasMfa, resetMfa } from "../../lib/mfa.js";
import { isExpired } from "../../lib/invites.js";
import { badRequest, conflict, forbidden, HttpError, json, mapDbError, notFound, parseBody } from "../http.js";
import { dispatch, queueClubInvite, siteUrl } from "../../lib/mail/invite-mail.js";
import { queueEmail } from "../../lib/mail/outbox.js";
import type { Router } from "../router.js";
import { checkId, clean, deleteItem, getItem, now, optStr, putItem, queryAll, str } from "../util.js";

const CLUB_ID = /^[a-z0-9][a-z0-9-]{1,29}$/;
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "use a color like #15294D").transform((s) => s.toUpperCase());
const colors = z.object({ primary: hex, accent: hex });
const link = z.object({
  label: str(80).min(1),
  url: z.string().trim().max(500).regex(/^https?:\/\/\S+$/i, "links must start with http:// or https://")
});
const email = z.string().trim().toLowerCase().email().max(200);

const clubSchema = z.object({
  name: str(80).min(1, "Enter the club's name."),
  short: optStr(12),
  colors,
  links: z.array(link).max(12).default([]),
  notes: str(4000).default("")
});
const createSchema = z.object({
  clubId: z.string().regex(CLUB_ID, "lowercase letters, numbers and dashes"),
  name: str(80).min(1, "Enter the club's name."),
  short: optStr(12),
  colors: colors.optional(),
  adminEmails: z.array(email).max(10).default([])
});
const adminSchema = z.object({ email, firstName: optStr(60), lastName: optStr(60), sendEmail: z.boolean().default(true) });

const INVITE_DAYS = 60;

async function admins(clubId: string) {
  return (await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :a)", ExpressionAttributeValues: { ":p": `CLUB#${clubId}`, ":a": "ADMIN#" } }))
    .map((a) => ({ sub: String(a.SK).slice(6), email: String(a.email ?? ""), firstName: String(a.firstName ?? ""), lastName: String(a.lastName ?? ""), at: a.at }));
}

function inviteItem(addr: string, clubId: string, by: string, name: { firstName?: string; lastName?: string } = {}) {
  return {
    ...keys.clubInvite(addr, clubId), ...keys.clubInviteGsi(addr, clubId),
    type: "ClubInvite", clubId, email: normEmail(addr), role: "clubAdmin", firstName: name.firstName ?? "", lastName: name.lastName ?? "",
    invitedBy: by, at: now(), ttl: Math.floor(Date.now() / 1000) + INVITE_DAYS * 86400
  };
}

export function clubRoutes(r: Router) {
  /** Clubs you run; site owners see every club. */
  r.on("GET", "/clubs", async ({ caller }) => {
    const owner = await isPlatformAdmin(caller);
    const ids = owner
      ? (await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": "CLUBS" } })).map((c) => String(c.SK).slice(5))
      : (await queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :c)", ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":c": "CLUB#" } }))
        .map((a) => String(a.GSI1SK).slice(5));
    const [clubs, controls] = await Promise.all([getClubs(ids), getControlsMany(ids)]);
    const list = [...clubs.values()].map((c) => ({ ...c, ...(controls.get(c.clubId)?.status === "inactive" ? { inactive: true } : {}) }));
    return json(200, { platformAdmin: owner, clubs: list.sort((a, b) => a.name.localeCompare(b.name)) });
  });

  /** Site owners add a club, optionally inviting its first admins. */
  r.on("POST", "/clubs", async ({ caller, body }) => {
    await requirePlatformAdmin(caller, "Only the site owner can add clubs.");
    const b = parseBody(createSchema, body);
    const at = now();
    const club = { clubId: b.clubId, name: b.name, short: b.short ?? "", colors: b.colors ?? DEFAULT_COLORS, links: [], notes: "" };
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: { ...keys.club(b.clubId), type: "Club", ...club, createdAt: at, createdBy: caller.sub, updatedAt: at } } },
          { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: { ...keys.clubDir(b.clubId), type: "ClubDir", clubId: b.clubId, name: b.name, createdAt: at } } },
          ...[...new Set(b.adminEmails)].map((e) => ({ Put: { TableName: TABLE, Item: inviteItem(e, b.clubId, caller.sub) } }))
        ]
      }));
    } catch (e) { mapDbError(e, "A club with that id already exists."); }
    const ids: string[] = [];
    for (const addr of new Set(b.adminEmails)) {
      const invite = await getItem(keys.clubInvite(addr, b.clubId));
      const id = invite ? await queueClubInvite(invite, caller.sub) : null;
      if (id) ids.push(id);
    }
    await dispatch(ids);
    return json(201, club);
  });

  /** Everything a club admin manages: settings, teams, admins and pending admin invites. */
  r.on("GET", "/clubs/{clubId}", async ({ caller, params }) => {
    const { clubId } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    const club = await getClub(clubId);
    if (!club) throw notFound("That club doesn't exist.");
    const [teams, adminList, invites, controls] = await Promise.all([
      queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" } }),
      admins(clubId),
      queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :c AND begins_with(GSI1SK, :i)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":i": "INVITE#" } }),
      getControls(clubId)
    ]);
    return json(200, {
      club,
      // Set by site owners (site admin dashboard): active or not, the team limit and the club's features.
      controls: { ...publicControls(controls), activeTeams: teams.filter((t) => !t.archived).length },
      teams: teams.map((t) => ({ teamId: String(t.SK).slice(5), ...clean(t) })),
      // Whether each admin has two-step sign-in on: their admin tools work only when it is.
      admins: await Promise.all(adminList.map(async (a) => ({ ...a, mfa: await hasMfa(a.sub) }))),
      invites: invites.map((i) => ({
        email: i.email, firstName: i.firstName ?? "", lastName: i.lastName ?? "", at: i.at,
        ...(Number(i.ttl) > 0 ? { expires: new Date(Number(i.ttl) * 1000).toISOString(), ...(isExpired(i) ? { expired: true } : {}) } : {}),
        ...(i.emailStatus ? { emailStatus: i.emailStatus, emailAt: i.emailAt, emailDetail: i.emailDetail || undefined } : {})
      }))
    });
  });

  /** Name, colors, and the links and notes every team in the club sees on Team Info. */
  r.on("PUT", "/clubs/{clubId}", async ({ caller, params, body }) => {
    const { clubId } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    const b = parseBody(clubSchema, body);
    let base = await getItem(keys.club(clubId));
    if (!base) {
      // The default club is created on first use.
      if (!(await getClub(clubId))) throw notFound("That club doesn't exist.");
      base = (await getItem(keys.club(clubId))) ?? {};
    }
    const at = now();
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...base, ...keys.club(clubId), type: "Club", clubId, ...b, short: b.short ?? "", updatedAt: at, updatedBy: caller.sub } } },
        { Put: { TableName: TABLE, Item: { ...keys.clubDir(clubId), type: "ClubDir", clubId, name: b.name, createdAt: base.createdAt ?? at } } }
      ]
    }));
    return json(200, toClub({ ...b, clubId }));
  });

  /** Invite another club admin. People who already have an account get it the next time they open the app. */
  r.on("POST", "/clubs/{clubId}/admins", async ({ caller, params, body }) => {
    const { clubId } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    const b = parseBody(adminSchema, body);
    if ((await admins(clubId)).some((a) => normEmail(a.email) === b.email)) throw conflict("That person is already an admin of this club.");
    const invite = inviteItem(b.email, clubId, caller.sub, b);
    await putItem(invite);
    if (b.sendEmail) {
      const id = await queueClubInvite(invite, caller.sub);
      if (id) await dispatch([id]);
    }
    return json(201, { email: b.email, emailed: b.sendEmail });
  });

  r.on("DELETE", "/clubs/{clubId}/admins/{sub}", async ({ caller, params }) => {
    const { clubId, platformAdmin } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    const sub = checkId(params.sub, "admin");
    const list = await admins(clubId);
    if (!list.some((a) => a.sub === sub)) throw notFound("That person isn't an admin of this club.");
    if (list.length <= 1 && !platformAdmin) throw conflict("A club needs at least one admin. Add someone else first.");
    await deleteItem(keys.clubAdmin(clubId, sub));
    return json(204, undefined);
  });

  /** A club admin lost their phone: a site owner turns off their authenticator app so they can set it up again. */
  r.on("POST", "/clubs/{clubId}/admins/{sub}/reset-mfa", async ({ caller, params }) => {
    await requirePlatformAdmin(caller, "Only site owners can reset two-step sign-in.");
    const clubId = checkId(params.clubId, "club");
    const sub = checkId(params.sub, "admin");
    if (sub === caller.sub) throw badRequest("Turn your own two-step sign-in off or on from Your teams.");
    if (!(await admins(clubId)).some((a) => a.sub === sub)) throw notFound("That person isn't an admin of this club.");
    await resetMfa(sub);
    console.log(JSON.stringify({ audit: "reset-mfa", by: caller.sub, sub, clubId }));
    // Tell them, in case they didn't ask for it.
    const admin = (await admins(clubId)).find((a) => a.sub === sub);
    if (admin?.email) {
      const club = await getClub(clubId);
      const { id, queued } = await queueEmail({
        msg: "mfaReset", to: admin.email, clubId, by: caller.sub, dedupe: `mfaReset:${sub}:${now()}`,
        data: { firstName: admin.firstName, clubName: club?.name ?? clubId, siteUrl: siteUrl() }
      });
      if (queued) await dispatch([id]);
    }
    return json(204, undefined);
  });

  /** Emails a club admin invite (again), reviving an expired one for two more weeks. */
  r.on("POST", "/clubs/{clubId}/invites/{email}/send", async ({ caller, params }) => {
    const { clubId } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    if (!email.safeParse(params.email).success) throw badRequest("That isn't an email address.");
    const invite = await getItem(keys.clubInvite(params.email, clubId));
    if (!invite) throw notFound("That invite isn't waiting any more. It may have been accepted.");
    if (invite.emailStatus === "bounced" || invite.emailStatus === "complained") {
      throw conflict("Mail to that address won't be sent again. Withdraw this invite and invite the right address.");
    }
    if (invite.emailAt && Date.now() - Date.parse(String(invite.emailAt)) < 10 * 60_000 && ["queued", "sent", "delivered"].includes(String(invite.emailStatus))) {
      throw new HttpError(429, "It was emailed a few minutes ago. Give it a little while, and ask them to check spam.", "too_soon");
    }
    const minTtl = Math.floor(Date.now() / 1000) + 14 * 86400;
    const renewed = Number(invite.ttl) < minTtl ? { ...invite, ttl: minTtl } : invite;
    if (renewed !== invite) await putItem(renewed);
    const id = await queueClubInvite(renewed, caller.sub);
    if (id) await dispatch([id]);
    return json(202, { email: invite.email });
  });

  r.on("DELETE", "/clubs/{clubId}/invites/{email}", async ({ caller, params }) => {
    const { clubId } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    const addr = params.email;
    if (!email.safeParse(addr).success) throw badRequest("That isn't an email address.");
    await deleteItem(keys.clubInvite(addr, clubId));
    return json(204, undefined);
  });
}

