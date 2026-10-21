import { z } from "zod";
import { deleteSignIn } from "../../lib/cognito.js";
import { keys, normEmail } from "../../lib/keys.js";
import { PRIVACY_VERSION } from "../../shared/privacy.js";
import { badRequest, conflict, json, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { clean, deleteMany, getItem, now, putItem, queryAll } from "../util.js";

/**
 * A person's own data (R4): accept the privacy notice, download everything about them and their
 * family, and delete their account. Requests about a team's records (a player's details, the roster)
 * go to that team's coordinator, as the privacy notice says.
 */

type Item = Record<string, unknown>;

async function myRecords(sub: string) {
  const [profile, memberships, adminOf] = await Promise.all([
    getItem(keys.profile(sub)),
    queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)", ExpressionAttributeValues: { ":u": `USER#${sub}`, ":t": "TEAM#" } }),
    queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :c)", ExpressionAttributeValues: { ":u": `USER#${sub}`, ":c": "CLUB#" } })
  ]);
  const owner = await getItem(keys.platformAdmin(sub));
  return { profile, memberships, adminOf, owner };
}

const teamOf = (m: Item) => String(m.PK).slice(5);
const clubOf = (a: Item) => String(a.PK).slice(5);

export function accountRoutes(r: Router) {
  /** The person has read the current privacy notice. */
  r.on("PUT", "/me/privacy", async ({ caller, body }) => {
    const { version } = parseBody(z.object({ version: z.string() }), body);
    if (version !== PRIVACY_VERSION) throw badRequest("The privacy notice has changed. Reload the page and read the new version.");
    const profile = (await getItem(keys.profile(caller.sub))) ?? { ...keys.profile(caller.sub), type: "UserProfile", sub: caller.sub, createdAt: now() };
    const at = now();
    await putItem({ ...profile, privacyVersion: version, privacyAt: at });
    return json(200, { version, at });
  });

  /** Everything stored about you and your family, as one JSON file. */
  r.on("GET", "/me/export", async ({ caller }) => {
    const { profile, memberships, adminOf, owner } = await myRecords(caller.sub);
    const email = normEmail(String(profile?.email ?? ""));
    const teams = [];
    for (const m of memberships) {
      const teamId = teamOf(m);
      const pid = typeof m.pid === "string" && m.pid ? m.pid : "";
      const settings = await getItem(keys.settings(teamId));
      const team: Item = { teamId, teamName: settings?.teamName ?? teamId, roles: m.roles ?? [], status: m.status, joined: m.at };
      if (pid) {
        const [player, contacts, family, ledger, payments] = await Promise.all([
          getItem(keys.player(teamId, pid)),
          getItem(keys.contacts(teamId, pid)),
          getItem(keys.family(teamId, pid)),
          queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :l)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":l": "LEDGER#" } }),
          queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :y)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":y": "PAYMENT#" } })
        ]);
        team.player = player ? { ...clean(player), parents: (contacts?.parents as unknown[]) ?? [] } : null;
        team.family = family ? clean(family) : null;
        team.fundEntries = ledger.filter((l) => l.pid === pid).map((l) => clean(l));
        team.payments = payments.filter((p) => p.pid === pid || p.submittedBy === caller.sub).map((p) => clean(p));
      } else {
        const payments = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :y)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":y": "PAYMENT#" } });
        team.payments = payments.filter((p) => p.submittedBy === caller.sub).map((p) => clean(p));
      }
      teams.push(team);
    }
    const invites = email ? await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `INVITE#${email}` } }) : [];
    return json(200, {
      exportedAt: now(),
      about: "Everything Teem Hub stores about you and your family. Teams' schedules, announcements and other families' records aren't included.",
      account: profile ? clean(profile) : { sub: caller.sub },
      siteOwner: !!owner,
      clubAdminOf: adminOf.map((a) => clubOf(a)),
      teams,
      pendingInvites: invites.map((i) => clean(i))
    });
  });

  /**
   * Delete my account: the sign-in, profile, team memberships, club-admin records, pending invites, and
   * your own name, phone and email on your player's roster entry. The player's own record belongs to
   * the team; the coordinator removes it if asked. Payments and fund entries stay in the team's accounts
   * without your name. The last admin of a team or club, and site owners, hand over first.
   */
  r.on("DELETE", "/me", async ({ caller, body }) => {
    const { confirm } = parseBody(z.object({ confirm: z.string() }), body);
    if (confirm.trim().toUpperCase() !== "DELETE") throw badRequest("Type DELETE to confirm.");
    const { profile, memberships, adminOf, owner } = await myRecords(caller.sub);
    if (owner) throw conflict("You're a site owner. Ask another site owner to take that over before you delete your account.");

    const blocking: string[] = [];
    for (const m of memberships.filter((x) => x.status === "active" && (x.roles as string[] | undefined)?.includes("admin"))) {
      const teamId = teamOf(m);
      const admins = (await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :m)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":m": "MEMBER#" } }))
        .filter((x) => x.status === "active" && (x.roles as string[] | undefined)?.includes("admin"));
      if (admins.length <= 1) blocking.push(String((await getItem(keys.settings(teamId)))?.teamName ?? teamId));
    }
    for (const a of adminOf) {
      const clubId = clubOf(a);
      const admins = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :a)", ExpressionAttributeValues: { ":p": `CLUB#${clubId}`, ":a": "ADMIN#" } });
      if (admins.length <= 1) blocking.push(String((await getItem(keys.club(clubId)))?.name ?? clubId));
    }
    if (blocking.length) throw conflict(`You're the only admin of ${blocking.join(", ")}. Make someone else an admin first, then delete your account.`);

    const email = normEmail(String(profile?.email ?? caller.username ?? ""));
    // Your own phone and email on your player's roster entry (other parents listed there stay).
    for (const m of memberships) {
      const pid = typeof m.pid === "string" ? m.pid : "";
      if (!pid || !email) continue;
      const ct = await getItem(keys.contacts(teamOf(m), pid));
      const parents = (ct?.parents as { email?: string }[] | undefined) ?? [];
      const kept = parents.filter((p) => normEmail(p.email ?? "") !== email);
      if (ct && kept.length !== parents.length) await putItem({ ...ct, parents: kept, updatedAt: now(), updatedBy: "account-deleted" });
    }
    const invites = email ? await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `INVITE#${email}` }, ProjectionExpression: "PK, SK" }) : [];
    const key = (i: Item) => ({ PK: String(i.PK), SK: String(i.SK) });
    await deleteMany([...memberships.map(key), ...adminOf.map(key), ...invites.map(key), keys.profile(caller.sub)]);
    await deleteSignIn(caller.username || caller.sub);
    console.log(JSON.stringify({ msg: "account deleted", sub: caller.sub, teams: memberships.length, clubs: adminOf.length }));
    return json(204, undefined);
  });
}
