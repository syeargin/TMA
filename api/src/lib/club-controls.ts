/**
 * Site-owner controls for each club (site admin dashboard): whether the club is active, how many of
 * its teams may be active at once, and which features it may use. They live in their own record,
 * CLUB#<c> / CONTROLS, which only site owners change, so a club admin saving the club's name or
 * colors can never overwrite them.
 *
 * A club without the record is active, has every feature and no team limit: that's every club made
 * before the dashboard existed.
 *
 * Team limit: only teams that aren't archived count. `activeTeams` goes up in the same transaction
 * that creates or restores a team, with a condition that refuses it at the limit, so two admins
 * creating teams at once can't go over. Archiving or deleting a team gives the place back. The daily
 * retention job recounts every club in case the number ever drifts, and setting a limit recounts too.
 */
import { BatchGetCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import { keys } from "./keys.js";
import { queryAll } from "../api/util.js";
import { clubAllows, type ClubFeature, type ClubFeatureMap } from "../shared/features.js";

export type ClubStatus = "active" | "inactive";
export type ClubControls = {
  status: ClubStatus;
  /** Most teams that may be active (not archived) at once; null for no limit. */
  teamLimit: number | null;
  /** Switched-off features only. */
  features: ClubFeatureMap;
  /** Teams in the club that aren't archived, as last counted. */
  activeTeams: number | null;
  statusReason?: string; statusAt?: string; statusBy?: string;
  updatedAt?: string; updatedBy?: string;
};

export const DEFAULT_CONTROLS: ClubControls = { status: "active", teamLimit: null, features: {}, activeTeams: null };

export function toControls(item: Record<string, unknown> | undefined | null): ClubControls {
  if (!item) return { ...DEFAULT_CONTROLS, features: {} };
  const limit = item.teamLimit;
  return {
    status: item.status === "inactive" ? "inactive" : "active",
    teamLimit: typeof limit === "number" && limit >= 0 ? limit : null,
    features: (item.features as ClubFeatureMap | undefined) ?? {},
    activeTeams: typeof item.activeTeams === "number" ? item.activeTeams : null,
    ...(item.statusReason ? { statusReason: String(item.statusReason) } : {}),
    ...(item.statusAt ? { statusAt: String(item.statusAt) } : {}),
    ...(item.statusBy ? { statusBy: String(item.statusBy) } : {}),
    ...(item.updatedAt ? { updatedAt: String(item.updatedAt) } : {}),
    ...(item.updatedBy ? { updatedBy: String(item.updatedBy) } : {})
  };
}

export async function getControls(clubId: string): Promise<ClubControls> {
  return toControls((await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.clubControls(clubId) }))).Item);
}

export async function getControlsMany(clubIds: string[]): Promise<Map<string, ClubControls>> {
  const out = new Map<string, ClubControls>();
  const ids = [...new Set(clubIds)];
  for (let i = 0; i < ids.length; i += 100) {
    let Keys: Record<string, unknown>[] = ids.slice(i, i + 100).map(keys.clubControls);
    for (let attempt = 0; Keys.length && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys } } }));
      for (const it of res.Responses?.[TABLE] ?? []) out.set(String(it.PK).slice(5), toControls(it));
      Keys = (res.UnprocessedKeys?.[TABLE]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  for (const id of ids) if (!out.has(id)) out.set(id, toControls(null));
  return out;
}

/** What team members see of their club's controls: no reasons or who changed what. */
export const publicControls = (c: ClubControls) => ({ status: c.status, features: c.features, teamLimit: c.teamLimit });

export const isActive = (c: ClubControls) => c.status === "active";
export const allows = (c: ClubControls, f: ClubFeature) => clubAllows(c.features, f);

// ---------- the team count ----------

/** Teams in the club that aren't archived, counted from the club's team list. */
export async function countActiveTeams(clubId: string): Promise<number> {
  const teams = await queryAll({
    KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" },
    ProjectionExpression: "SK, archived"
  });
  return teams.filter((t) => !t.archived).length;
}

/**
 * A transaction step that takes one team place: refused when the club is inactive or at its limit.
 * Put it in the same transaction that creates or restores the team.
 */
export function takeTeamPlace(clubId: string, siteOwner = false) {
  // Site owners can add teams to an inactive club; the limit applies to everyone.
  const limit = "(attribute_not_exists(teamLimit) OR activeTeams < teamLimit)";
  return {
    Update: {
      TableName: TABLE, Key: keys.clubControls(clubId),
      UpdateExpression: "SET #t = if_not_exists(#t, :type) ADD activeTeams :one",
      ConditionExpression: siteOwner ? limit : `(attribute_not_exists(#s) OR #s = :active) AND ${limit}`,
      ExpressionAttributeNames: { "#t": "type", ...(siteOwner ? {} : { "#s": "status" }) },
      ExpressionAttributeValues: { ":type": "ClubControls", ":one": 1, ...(siteOwner ? {} : { ":active": "active" }) }
    }
  };
}

/** Gives a place back after a team is archived or deleted. Never fails the change itself. */
export async function releaseTeamPlace(clubId: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.clubControls(clubId),
      UpdateExpression: "ADD activeTeams :minus", ConditionExpression: "activeTeams > :zero",
      ExpressionAttributeValues: { ":minus": -1, ":zero": 0 }
    }));
  } catch (e) {
    if ((e as { name?: string }).name !== "ConditionalCheckFailedException") console.error(JSON.stringify({ msg: "team place release failed", clubId, error: String(e) }));
  }
}

/** Sets the stored count to the real one. Returns it. */
export async function recountTeams(clubId: string): Promise<number> {
  const n = await countActiveTeams(clubId);
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: keys.clubControls(clubId),
    UpdateExpression: "SET #t = if_not_exists(#t, :type), activeTeams = :n", ExpressionAttributeNames: { "#t": "type" },
    ExpressionAttributeValues: { ":type": "ClubControls", ":n": n }
  }));
  return n;
}

/** Why a new or restored team was refused, in words for the club admin. Null if it wasn't the club. */
export async function placeRefusal(clubId: string, siteOwner = false): Promise<string | null> {
  const c = await getControls(clubId);
  if (!isActive(c) && !siteOwner) return "This club is inactive, so no teams can be added or restored. A site owner can reactivate it.";
  if (c.teamLimit !== null && (c.activeTeams ?? 0) >= c.teamLimit) {
    return `Your club is at its limit of ${c.teamLimit} active team${c.teamLimit === 1 ? "" : "s"}. Archive a team, or ask a site owner to raise the limit.`;
  }
  return null;
}

/** True when a cancelled transaction failed on its step at `index` (the team place). */
export function failedAt(e: unknown, index: number): boolean {
  const reasons = (e as { CancellationReasons?: { Code?: string }[] })?.CancellationReasons;
  return reasons?.[index]?.Code === "ConditionalCheckFailed";
}

/** Whether a club's teams send optional team emails: active and with Team emails on. */
export async function clubSendsEmail(clubId: string): Promise<boolean> {
  const c = await getControls(clubId);
  return isActive(c) && allows(c, "email");
}
