import { z } from "zod";
import { keys, normEmail } from "../../lib/keys.js";
import { ROLES } from "../../shared/permissions.js";
import { loadAccess } from "../context.js";
import { conflict, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, clean, deleteItem, getItem, now, optStr, putItem, queryAll } from "../util.js";

const roles = z.array(z.enum(ROLES)).min(1).max(ROLES.length).transform((r) => [...new Set(r)]);
const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  roles,
  person: optStr(120),
  firstName: optStr(60), lastName: optStr(60),
  pid: optStr(64)
});
const memberSchema = z.object({ roles, person: optStr(120), firstName: optStr(60), lastName: optStr(60), pid: optStr(64) });

const INVITE_DAYS = 60;

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
    return json(200, { invites: items.map((i) => clean(i)) });
  });

  /** Invites an email to this team. People who already have an account get it the next time they open the app. */
  r.on("POST", "/teams/{teamId}/invites", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    const b = parseBody(inviteSchema, body);
    const members = await activeMembers(a.teamId);
    if (members.some((m) => normEmail(String(m.email ?? "")) === b.email)) throw conflict("That person is already on this team.");
    const at = now();
    await putItem({
      ...keys.invite(b.email, a.teamId), ...keys.inviteGsi(b.email, a.teamId),
      type: "Invite", teamId: a.teamId, email: b.email, roles: b.roles, person: b.person ?? "", firstName: b.firstName ?? "", lastName: b.lastName ?? "", pid: b.pid ?? "",
      invitedBy: caller.sub, at, ttl: Math.floor(Date.now() / 1000) + INVITE_DAYS * 86400
    });
    return json(201, { email: b.email });
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
    return json(204, undefined);
  });
}
