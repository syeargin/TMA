import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/db.js";
import { clubOfTeam, DEFAULT_CLUB } from "../lib/clubs.js";
import { keys } from "../lib/keys.js";
import { can, type Permission } from "../shared/permissions.js";
import { hasMfa } from "../lib/mfa.js";
import { conflict, forbidden, mfaRequired } from "./http.js";
import { getItem } from "./util.js";

/** The default club (teams made before clubs existed). Most code should use access.clubId instead. */
export const CLUB_ID = DEFAULT_CLUB;

export type Membership = {
  sub: string; status: string; person?: string; pid?: string; roles: string[]; email?: string; at?: string;
};

export type Caller = { sub: string; username: string };

/** Everything a route needs to decide what this caller may do on one team. */
export class TeamAccess {
  constructor(
    public caller: Caller,
    public teamId: string,
    public member: Membership | null,
    /** Admin of this team's club (or a site owner): full admin on every team in the club. */
    public clubAdmin: boolean,
    public clubId: string = DEFAULT_CLUB(),
    public platformAdmin = false,
    /** Has club-admin or site-owner rights here, but can't use them until two-step sign-in is on. */
    public mfaNeeded = false
  ) {}

  get roles(): Set<string> {
    const r = new Set(this.member?.status === "active" ? this.member.roles : []);
    if (this.clubAdmin) r.add("admin");
    return r;
  }

  get isMember() { return this.clubAdmin || this.member?.status === "active"; }

  can(perm: Permission) { return can(this.roles, perm); }

  require(perm: Permission) {
    if (!this.can(perm)) throw this.mfaNeeded ? mfaRequired() : forbidden();
  }

  /** Parent of this player (the membership's family), with the family role. */
  isParentOf(pid: string | undefined) {
    return !!pid && this.member?.status === "active" && this.member.pid === pid && this.roles.has("parent");
  }
}

export async function loadAccess(caller: Caller, teamId: string): Promise<TeamAccess> {
  const clubId = await clubOfTeam(teamId);
  const res = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [TABLE]: { Keys: [keys.member(teamId, caller.sub), keys.clubAdmin(clubId, caller.sub), keys.platformAdmin(caller.sub)] }
    }
  }));
  const items = res.Responses?.[TABLE] ?? [];
  const member = items.find((i) => String(i.SK).startsWith("MEMBER#")) as Membership | undefined;
  const owner = items.some((i) => i.PK === "PLATFORM");
  const elevated = owner || items.some((i) => i.PK === `CLUB#${clubId}`);
  // Club-admin and site-owner rights count only with two-step sign-in on (R2). Without it the
  // person keeps whatever their own team membership gives them.
  const unlocked = elevated && await hasMfa(caller.username);
  const access = new TeamAccess(caller, teamId, member ?? null, unlocked, clubId, unlocked && owner, elevated && !unlocked);
  if (!access.isMember) throw access.mfaNeeded ? mfaRequired() : forbidden("You're not a member of this team.");
  return access;
}

/** Club admins (and site owners) manage a club's settings, admins and teams. */
export async function loadClubAccess(caller: Caller, clubId: string): Promise<{ clubId: string; platformAdmin: boolean }> {
  const res = await ddb.send(new BatchGetCommand({
    RequestItems: { [TABLE]: { Keys: [keys.clubAdmin(clubId, caller.sub), keys.platformAdmin(caller.sub)] } }
  }));
  const items = res.Responses?.[TABLE] ?? [];
  const platformAdmin = items.some((i) => i.PK === "PLATFORM");
  if (!platformAdmin && !items.length) throw forbidden("Only this club's admins can do that.");
  if (!(await hasMfa(caller.username))) throw mfaRequired();
  return { clubId, platformAdmin };
}

/** Archived teams are read-only for everyone until a site owner restores them. */
export async function assertTeamWritable(teamId: string) {
  const dir = await getItem(keys.teamDir(await clubOfTeam(teamId), teamId));
  if (dir?.archived) throw conflict("This team is archived, so it's read-only. A site owner can restore it.");
}

async function hasPlatformRecord(sub: string): Promise<boolean> {
  const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: [keys.platformAdmin(sub)] } } }));
  return !!res.Responses?.[TABLE]?.length;
}

/** A site owner with two-step sign-in on. Lists use this; actions use requirePlatformAdmin. */
export async function isPlatformAdmin(caller: Caller): Promise<boolean> {
  return (await hasPlatformRecord(caller.sub)) && hasMfa(caller.username);
}

/** Site-owner actions: refuses others, and asks site owners to turn on two-step sign-in first. */
export async function requirePlatformAdmin(caller: Caller, message: string): Promise<void> {
  if (!(await hasPlatformRecord(caller.sub))) throw forbidden(message);
  if (!(await hasMfa(caller.username))) throw mfaRequired();
}
