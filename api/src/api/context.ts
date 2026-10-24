import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/db.js";
import { clubOfTeam, DEFAULT_CLUB } from "../lib/clubs.js";
import { keys } from "../lib/keys.js";
import { can, type Permission } from "../shared/permissions.js";
import { FEATURES, isOn, effectiveFeatures, type Feature, type FeatureMap } from "../shared/features.js";
import { allows, getControls, isActive, toControls, type ClubControls } from "../lib/club-controls.js";
import { hasMfa } from "../lib/mfa.js";
import { conflict, forbidden, HttpError, mfaRequired } from "./http.js";
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
    public mfaNeeded = false,
    /** The team's own switched-off features (team settings). */
    public teamFeatures: FeatureMap = {},
    /** The club's controls (site admin dashboard): active or not, team limit, features it may use. */
    public club: ClubControls = toControls(null)
  ) {}

  /** What the team can use: off if the team or its club switched it off. */
  get features(): FeatureMap { return effectiveFeatures(this.teamFeatures, this.club.features); }

  has(feature: Feature) { return isOn(this.features, feature); }

  /** Refuses changes to a feature the team, or its club, has turned off. */
  requireFeature(feature: Feature) {
    if (!allows(this.club, feature)) throw new HttpError(409, `${FEATURES[feature].label} isn't included for your club. A site owner can turn it on.`, "feature_off");
    if (!this.has(feature)) throw new HttpError(409, `${FEATURES[feature].label} is turned off for this team. An admin or coordinator can turn it on in team settings.`, "feature_off");
  }

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
      [TABLE]: { Keys: [keys.member(teamId, caller.sub), keys.clubAdmin(clubId, caller.sub), keys.platformAdmin(caller.sub), keys.settings(teamId), keys.clubControls(clubId)] }
    }
  }));
  const items = res.Responses?.[TABLE] ?? [];
  const member = items.find((i) => String(i.SK).startsWith("MEMBER#")) as Membership | undefined;
  const features = (items.find((i) => i.SK === "META#SETTINGS")?.features ?? {}) as FeatureMap;
  const controls = toControls(items.find((i) => i.SK === "CONTROLS"));
  const owner = items.some((i) => i.PK === "PLATFORM");
  const elevated = owner || items.some((i) => i.PK === `CLUB#${clubId}` && String(i.SK).startsWith("ADMIN#"));
  // Club-admin and site-owner rights count only with two-step sign-in on (R2). Without it the
  // person keeps whatever their own team membership gives them.
  const unlocked = elevated && await hasMfa(caller.username);
  const access = new TeamAccess(caller, teamId, member ?? null, unlocked, clubId, unlocked && owner, elevated && !unlocked, features, controls);
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

/**
 * Archived teams, and every team in an inactive club, are read-only for everyone until a site owner
 * restores the team or reactivates the club.
 */
export async function assertTeamWritable(teamId: string) {
  const clubId = await clubOfTeam(teamId);
  const [dir, controls] = await Promise.all([getItem(keys.teamDir(clubId, teamId)), getControls(clubId)]);
  if (!isActive(controls)) throw conflict(INACTIVE, "club_inactive");
  if (dir?.archived) throw conflict("This team is archived, so it's read-only. A site owner can restore it.");
}

export const INACTIVE = "This club is inactive, so its teams are read-only. A site owner can reactivate it.";

/** An inactive club's settings, admins and teams can't change either. */
export async function assertClubWritable(clubId: string) {
  if (!isActive(await getControls(clubId))) throw conflict(INACTIVE, "club_inactive");
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
