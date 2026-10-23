/**
 * Invite emails: what goes in them, and queuing them. Used by the Members page (one invite, "Email
 * invite" again, "Email all waiting invites") and the club page (club admin invites).
 */
import { getClub } from "../clubs.js";
import { keys, normEmail } from "../keys.js";
import { getItem } from "../../api/util.js";
import { dispatch, queueEmail } from "./outbox.js";

export const siteUrl = () => (process.env.SITE_URL || "http://localhost:4200").replace(/\/$/, "");

async function personName(sub: string | undefined): Promise<string> {
  if (!sub) return "";
  const p = await getItem(keys.profile(sub));
  return [p?.firstName, p?.lastName].filter((x) => typeof x === "string" && x).join(" ");
}

const expiresIso = (ttl: unknown) => (Number(ttl) > 0 ? new Date(Number(ttl) * 1000).toISOString() : undefined);

/** Queues the email for one team invite (the stored invite item). Returns the delivery id, or null if it was already queued. */
export async function queueTeamInvite(invite: Record<string, unknown>, clubId: string, by: string): Promise<string | null> {
  const teamId = String(invite.teamId);
  const email = normEmail(String(invite.email));
  const [settings, club, inviter] = await Promise.all([getItem(keys.settings(teamId)), getClub(clubId), personName(String(invite.invitedBy || by))]);
  const pid = typeof invite.pid === "string" ? invite.pid : "";
  const roles = (invite.roles as string[] | undefined) ?? ["parent"];
  // Only the player's first name: if the address has a typo, a stranger learns as little as possible (R30).
  const player = pid && roles.includes("parent") ? await getItem(keys.player(teamId, pid)) : undefined;
  const { id, queued } = await queueEmail({
    msg: "invite", to: email, teamId, clubId, by,
    link: keys.invite(email, teamId),
    dedupe: `invite:${teamId}:${email}:${Number(invite.emailCount ?? 0) + 1}:${String(invite.at ?? "")}`,
    data: {
      teamName: String(settings?.teamName ?? teamId), clubName: club?.name, colors: club?.colors,
      inviterName: inviter, roles, playerName: typeof player?.first === "string" ? player.first : undefined,
      email, expires: expiresIso(invite.ttl), siteUrl: siteUrl()
    }
  });
  return queued ? id : null;
}

/** Queues the email for one club admin invite. */
export async function queueClubInvite(invite: Record<string, unknown>, by: string): Promise<string | null> {
  const clubId = String(invite.clubId);
  const email = normEmail(String(invite.email));
  const [club, inviter] = await Promise.all([getClub(clubId), personName(String(invite.invitedBy || by))]);
  const { id, queued } = await queueEmail({
    msg: "clubInvite", to: email, clubId, by,
    link: keys.clubInvite(email, clubId),
    dedupe: `clubInvite:${clubId}:${email}:${Number(invite.emailCount ?? 0) + 1}:${String(invite.at ?? "")}`,
    data: { clubName: club?.name ?? clubId, colors: club?.colors, inviterName: inviter, email, expires: expiresIso(invite.ttl), siteUrl: siteUrl() }
  });
  return queued ? id : null;
}

export { dispatch };
