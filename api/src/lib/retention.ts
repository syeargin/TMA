import { forgetTeamClubs, DEFAULT_CLUB } from "./clubs.js";
import { keys } from "./keys.js";
import { deleteMany, queryAll } from "../api/util.js";

/**
 * How long things are kept (R4, R31). The privacy notice quotes these numbers, so change both together.
 * - An archived team is deleted 90 days after it was archived, unless it's restored first.
 * - "Delete team" archives the team at once and deletes it 7 days later, so a mistake can be undone.
 */
export const ARCHIVE_DAYS = 90;
export const DELETE_GRACE_DAYS = 7;

const DAY = 86_400_000;
export const daysFrom = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * DAY).toISOString();

/** When an archived team is due to be deleted: the date set on it, or 90 days after archiving. */
export function purgeDate(dir: Record<string, unknown>): string | undefined {
  if (!dir.archived) return undefined;
  if (typeof dir.purgeAt === "string") return dir.purgeAt;
  return typeof dir.archivedAt === "string" ? daysFrom(dir.archivedAt, ARCHIVE_DAYS) : undefined;
}

/**
 * Delete a team and everything stored for it: its whole partition, its line in the club's team list and
 * invites still waiting for it. People's accounts stay (they can be on other teams).
 */
export async function purgeTeam(teamId: string, clubId: string, by: string): Promise<number> {
  const [records, invites] = await Promise.all([
    queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${teamId}` }, ProjectionExpression: "PK, SK" }),
    queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :t AND begins_with(GSI1SK, :i)", ExpressionAttributeValues: { ":t": `TEAM#${teamId}`, ":i": "INVITE#" }, ProjectionExpression: "PK, SK" })
  ]);
  const key = (i: Record<string, unknown>) => ({ PK: String(i.PK), SK: String(i.SK) });
  // The club link goes last, so a run that stops partway can be repeated and still finds the club.
  const clubLink = records.filter((i) => i.SK === "META#CLUB").map(key);
  const rest = [keys.teamDir(clubId, teamId), ...invites.map(key), ...records.filter((i) => i.SK !== "META#CLUB").map(key)];
  await deleteMany(rest);
  await deleteMany(clubLink);
  forgetTeamClubs();
  const count = rest.length + clubLink.length;
  console.log(JSON.stringify({ msg: "team deleted", teamId, clubId, by, records: count }));
  return count;
}

/** The daily job: deletes every archived team whose date has come. */
export async function purgeDue(at = new Date().toISOString()): Promise<{ teamId: string; clubId: string }[]> {
  const clubIds = new Set([DEFAULT_CLUB(), ...(await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": "CLUBS" } })).map((c) => String(c.SK).slice(5))]);
  const done: { teamId: string; clubId: string }[] = [];
  for (const clubId of clubIds) {
    const dirs = await queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" } });
    for (const d of dirs) {
      const when = purgeDate(d);
      if (!when || when > at) continue;
      const teamId = String(d.SK).slice(5);
      await purgeTeam(teamId, clubId, "retention");
      done.push({ teamId, clubId });
    }
  }
  return done;
}
