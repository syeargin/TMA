/**
 * Site admin dashboard (site owners, with two-step sign-in): every club with its status, team count
 * and features, and the controls to change them. Each change is written to the club's change log
 * (CLUB#<c> / AUDIT#<time>) with who made it and why.
 */
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { DEFAULT_CLUB, getClubs } from "../../lib/clubs.js";
import { getControls, getControlsMany, recountTeams, type ClubControls } from "../../lib/club-controls.js";
import { CLUB_FEATURE_KEYS, CLUB_FEATURES, type ClubFeature } from "../../shared/features.js";
import { requirePlatformAdmin } from "../context.js";
import { badRequest, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, getItem, now, putItem, queryAll, str } from "../util.js";

const text = (v: unknown) => (typeof v === "string" ? v : "");
const OWNER_ONLY = "Only site owners can use the site admin dashboard.";

const controlsSchema = z.object({
  status: z.enum(["active", "inactive"]).optional(),
  teamLimit: z.number().int().min(0).max(1000).nullable().optional(),
  features: z.record(z.enum(CLUB_FEATURE_KEYS as [string, ...string[]]), z.boolean()).optional(),
  /** Why: required to make a club inactive, kept in the change log. */
  reason: str(300).optional()
}).refine((b) => b.status !== undefined || b.teamLimit !== undefined || b.features !== undefined, "send status, teamLimit or features");

async function clubIds(): Promise<string[]> {
  const listed = (await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": "CLUBS" } })).map((c) => String(c.SK).slice(5));
  return [...new Set([DEFAULT_CLUB(), ...listed])];
}

async function nameOf(sub: string | undefined): Promise<string> {
  if (!sub) return "";
  const p = await getItem(keys.profile(sub));
  return [text(p?.firstName), text(p?.lastName)].filter(Boolean).join(" ") || text(p?.email) || "A site owner";
}

/** One club's row on the dashboard. */
async function row(clubId: string, club: { name: string; short: string; colors: unknown } | undefined, c: ClubControls) {
  const [teams, admins] = await Promise.all([
    queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" }, ProjectionExpression: "SK, archived, #n, createdAt", ExpressionAttributeNames: { "#n": "name" } }),
    queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :a)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":a": "ADMIN#" }, ProjectionExpression: "SK" })
  ]);
  const active = teams.filter((t) => !t.archived);
  return {
    clubId, name: club?.name ?? clubId, short: club?.short ?? "", colors: club?.colors,
    status: c.status, statusReason: c.statusReason ?? "", statusAt: c.statusAt ?? "",
    teamLimit: c.teamLimit, activeTeams: active.length, archivedTeams: teams.length - active.length,
    admins: admins.length, features: c.features,
    teams: active.map((t) => ({ teamId: String(t.SK).slice(5), name: text(t.name) })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

/** Each team's settings is touched so anyone with the team open reloads it (live updates). */
async function nudgeTeams(clubId: string, at: string) {
  const teams = await queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" }, ProjectionExpression: "SK" });
  for (const t of teams) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.settings(String(t.SK).slice(5)), ConditionExpression: "attribute_exists(PK)",
      UpdateExpression: "SET updatedAt = :at", ExpressionAttributeValues: { ":at": at }
    })).catch((e) => { if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e; });
  }
}

export function adminRoutes(r: Router) {
  r.on("GET", "/admin/clubs", async ({ caller }) => {
    await requirePlatformAdmin(caller, OWNER_ONLY);
    const ids = await clubIds();
    const [clubs, controls] = await Promise.all([getClubs(ids), getControlsMany(ids)]);
    const rows = await Promise.all(ids.filter((id) => clubs.has(id)).map((id) => row(id, clubs.get(id), controls.get(id)!)));
    rows.sort((a, b) => Number(a.status === "inactive") - Number(b.status === "inactive") || a.name.localeCompare(b.name));
    return json(200, { clubs: rows, features: CLUB_FEATURE_KEYS.map((f) => ({ id: f, ...CLUB_FEATURES[f] })) });
  });

  /** Make a club active or inactive, set its team limit, and turn features on or off. */
  r.on("PUT", "/admin/clubs/{clubId}", async ({ caller, params, body }) => {
    await requirePlatformAdmin(caller, OWNER_ONLY);
    const clubId = checkId(params.clubId, "club");
    const club = (await getClubs([clubId])).get(clubId);
    if (!club) throw notFound("That club doesn't exist.");
    const b = parseBody(controlsSchema, body);
    const before = await getControls(clubId);
    if (b.status === "inactive" && before.status !== "inactive" && !b.reason?.trim()) throw badRequest("Say why the club is being made inactive. It's kept in the club's history.");

    const at = now();
    const changes: string[] = [];
    const sets = ["#t = :type", "updatedAt = :at", "updatedBy = :by"];
    const removes: string[] = [];
    const names: Record<string, string> = { "#t": "type" };
    const values: Record<string, unknown> = { ":type": "ClubControls", ":at": at, ":by": caller.sub };

    if (b.status && b.status !== before.status) {
      sets.push("#s = :s", "statusAt = :at", "statusBy = :by", "statusReason = :why");
      names["#s"] = "status";
      values[":s"] = b.status;
      values[":why"] = b.reason?.trim() ?? "";
      changes.push(b.status === "inactive" ? "Made the club inactive" : "Made the club active again");
    }
    if (b.teamLimit !== undefined && b.teamLimit !== before.teamLimit) {
      if (b.teamLimit === null) removes.push("teamLimit"); else { sets.push("teamLimit = :lim"); values[":lim"] = b.teamLimit; }
      changes.push(b.teamLimit === null ? `Removed the team limit (was ${before.teamLimit})` : `Team limit ${before.teamLimit === null ? "set to" : `${before.teamLimit} →`} ${b.teamLimit}`);
    }
    if (b.features) {
      const next = { ...before.features };
      for (const [f, on] of Object.entries(b.features) as [ClubFeature, boolean][]) {
        const was = before.features[f] !== false;
        if (on === was) continue;
        if (on) delete next[f]; else next[f] = false;
        changes.push(`${CLUB_FEATURES[f].label} ${on ? "on" : "off"}`);
      }
      sets.push("features = :f");
      values[":f"] = next;
    }
    if (!changes.length) return json(200, { changed: false, ...(await row(clubId, club, before)) });

    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.clubControls(clubId),
      UpdateExpression: `SET ${sets.join(", ")}${removes.length ? " REMOVE " + removes.join(", ") : ""}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values
    }));
    // The limit compares against an exact count from here on.
    await recountTeams(clubId);
    await putItem({ ...keys.clubAudit(clubId, `${at}#${caller.sub.slice(0, 8)}`), type: "ClubAudit", clubId, at, by: caller.sub, changes, reason: b.reason?.trim() ?? "" });
    // Status and features change what every team in the club can do: open pages reload.
    if (b.status || b.features) await nudgeTeams(clubId, at);
    console.log(JSON.stringify({ msg: "club controls changed", clubId, by: caller.sub, changes }));
    return json(200, { changed: true, ...(await row(clubId, club, await getControls(clubId))) });
  });

  /** The club's change log, newest first. */
  r.on("GET", "/admin/clubs/{clubId}/history", async ({ caller, params }) => {
    await requirePlatformAdmin(caller, OWNER_ONLY);
    const clubId = checkId(params.clubId, "club");
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: "PK = :c AND begins_with(SK, :a)", ScanIndexForward: false, Limit: 50,
      ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":a": "AUDIT#" }
    }));
    const items = res.Items ?? [];
    const names = new Map<string, string>();
    for (const s of new Set(items.map((i) => String(i.by)))) names.set(s, await nameOf(s));
    return json(200, { history: items.map((i) => ({ at: i.at, by: names.get(String(i.by)) ?? "", changes: i.changes ?? [], reason: i.reason ?? "" })) });
  });
}


