import { z } from "zod";
import { keys, normEmail } from "../../lib/keys.js";
import { ROLES } from "../../shared/permissions.js";
import { loadAccess } from "../context.js";
import { conflict, HttpError, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { forgetSeen } from "../../lib/usage.js";
import { checkId, clean, deleteItem, getItem, now, optStr, putItem, queryAll } from "../util.js";
import { isExpired } from "../../lib/invites.js";
import { dispatch, queueTeamInvite } from "../../lib/mail/invite-mail.js";

const roles = z.array(z.enum(ROLES)).min(1).max(ROLES.length).transform((r) => [...new Set(r)]);
const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  roles,
  person: optStr(120),
  firstName: optStr(60), lastName: optStr(60),
  pid: optStr(64),
  /** Email the invite now (Messaging M1). The Members page leaves this on. */
  sendEmail: z.boolean().default(true)
});
const memberSchema = z.object({ roles, person: optStr(120), firstName: optStr(60), lastName: optStr(60), pid: optStr(64) });

const INVITE_DAYS = 60;
/** Emailing an invite again gives it at least this long, so an expired one can be revived. */
const RESEND_DAYS = 14;
/** "Email invite" again only after this long, unless the last one bounced or failed. */
const RESEND_WAIT_MS = 10 * 60_000;
/** "Email all waiting invites" at most this many at a time. */
const BULK_MAX = 200;

async function activeMembers(teamId: string) {
  return (await queryAll({
    KeyConditionExpression: "PK = :p AND begins_with(SK, :m)",
    ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":m": "MEMBER#" }
  }))
    .filter((m) => m.status === "active")
    // Memberships written at sign-up in Phase 1 have no "sub" attribute; the key always has it.
    .map((m): Record<string, unknown> => ({ ...m, sub: String(m.SK).slice("MEMBER#".length) }));
}

export function peopleRoutes(r: Router) {
  r.on("GET", "/teams/{teamId}/invites", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    const items = await queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :t AND begins_with(GSI1SK, :i)",
      ExpressionAttributeValues: { ":t": `TEAM#${a.teamId}`, ":i": "INVITE#" }
    });
    // Expired invites can't be accepted any more (R30); show them as expired until DynamoDB removes them.
    return json(200, { invites: items.map((i) => ({ ...clean(i), ...(isExpired(i) ? { expired: true } : {}) })) });
  });

  /** Invites an email to this team. People who already have an account get it the next time they open the app. */
  r.on("POST", "/teams/{teamId}/invites", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    const b = parseBody(inviteSchema, body);
    const members = await activeMembers(a.teamId);
    if (members.some((m) => normEmail(String(m.email ?? "")) === b.email)) throw conflict("That person is already on this team.");
    const at = now();
    const invite = {
      ...keys.invite(b.email, a.teamId), ...keys.inviteGsi(b.email, a.teamId),
      type: "Invite", teamId: a.teamId, email: b.email, roles: b.roles, person: b.person ?? "", firstName: b.firstName ?? "", lastName: b.lastName ?? "", pid: b.pid ?? "",
      invitedBy: caller.sub, at, ttl: Math.floor(Date.now() / 1000) + INVITE_DAYS * 86400
    };
    await putItem(invite);
    if (b.sendEmail) {
      const id = await queueTeamInvite(invite, a.clubId, caller.sub);
      if (id) await dispatch([id]);
    }
    return json(201, { email: b.email, emailed: b.sendEmail });
  });

  /** Emails an invite (again). Revives an expired one for two more weeks. */
  r.on("POST", "/teams/{teamId}/invites/{email}/send", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    const invite = await getItem(keys.invite(params.email, a.teamId));
    if (!invite) throw notFound("That invite isn't waiting any more. It may have been accepted.");
    if (invite.emailStatus === "bounced" || invite.emailStatus === "complained") {
      throw conflict(invite.emailStatus === "bounced"
        ? "Mail to that address bounces, so it won't be sent again. Cancel this invite and invite the right address."
        : "They marked the invite as spam, so it won't be sent again. Ask them in person first.");
    }
    const recent = invite.emailAt && Date.now() - Date.parse(String(invite.emailAt)) < RESEND_WAIT_MS;
    if (recent && ["queued", "sent", "delivered"].includes(String(invite.emailStatus))) {
      throw new HttpError(429, "It was emailed a few minutes ago. Give it a little while, and ask them to check spam.", "too_soon");
    }
    const minTtl = Math.floor(Date.now() / 1000) + RESEND_DAYS * 86400;
    const renewed = Number(invite.ttl) < minTtl ? { ...invite, ttl: minTtl } : invite;
    if (renewed !== invite) await putItem(renewed);
    const id = await queueTeamInvite(renewed, a.clubId, caller.sub);
    if (id) await dispatch([id]);
    return json(202, { email: invite.email, expires: new Date(Number(renewed.ttl) * 1000).toISOString() });
  });

  /** Emails every waiting invite that hasn't been emailed yet, like the ones a spreadsheet import made. */
  r.on("POST", "/teams/{teamId}/invites/send-waiting", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    const waiting = (await queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :t AND begins_with(GSI1SK, :i)",
      ExpressionAttributeValues: { ":t": `TEAM#${a.teamId}`, ":i": "INVITE#" }
    })).filter((i) => !i.emailStatus && !isExpired(i)).slice(0, BULK_MAX);
    const ids: string[] = [];
    for (const inv of waiting) {
      const id = await queueTeamInvite(inv, a.clubId, caller.sub);
      if (id) ids.push(id);
    }
    await dispatch(ids);
    console.log(JSON.stringify({ msg: "invites emailed", teamId: a.teamId, by: caller.sub, count: ids.length }));
    return json(202, { queued: ids.length });
  });

  r.on("DELETE", "/teams/{teamId}/invites/{email}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    await deleteItem(keys.invite(params.email, a.teamId));
    return json(204, undefined);
  });

  r.on("GET", "/teams/{teamId}/members", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    const showEmail = a.can("accounts");
    const members = (await activeMembers(a.teamId)).map((m) => {
      const { email, invitedBy, ...pub } = clean(m)!;
      return showEmail ? { ...pub, email, invitedBy } : pub;
    });
    return json(200, { members });
  });

  r.on("PUT", "/teams/{teamId}/members/{sub}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    const sub = checkId(params.sub, "member");
    const b = parseBody(memberSchema, body);
    const existing = await getItem(keys.member(a.teamId, sub));
    if (!existing || existing.status !== "active") throw notFound("That person isn't on this team.");
    if ((existing.roles as string[]).includes("admin") && !b.roles.includes("admin") && !a.clubAdmin) {
      const admins = (await activeMembers(a.teamId)).filter((m) => (m.roles as string[]).includes("admin"));
      if (admins.length <= 1) throw conflict("A team needs at least one team admin. Make someone else an admin first.");
    }
    await putItem({ ...existing, sub, roles: b.roles, person: b.person ?? existing.person ?? "",
      firstName: b.firstName ?? existing.firstName ?? "", lastName: b.lastName ?? existing.lastName ?? "", pid: b.pid ?? existing.pid ?? "", updatedAt: now(), updatedBy: caller.sub });
    return json(200, { sub });
  });

  r.on("DELETE", "/teams/{teamId}/members/{sub}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    const sub = checkId(params.sub, "member");
    const existing = await getItem(keys.member(a.teamId, sub));
    if (!existing) throw notFound("That person isn't on this team.");
    if ((existing.roles as string[]).includes("admin") && !a.clubAdmin) {
      const admins = (await activeMembers(a.teamId)).filter((m) => (m.roles as string[]).includes("admin"));
      if (admins.length <= 1) throw conflict("A team needs at least one team admin. Make someone else an admin first.");
    }
    await deleteItem(keys.member(a.teamId, sub));
    await forgetSeen(a.teamId, sub);
    return json(204, undefined);
  });
}
