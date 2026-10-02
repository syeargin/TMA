import { BatchGetCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import { emailSet, keys } from "./keys.js";

/** The club that teams made before clubs existed belong to (and the one CLUB_ADMIN_EMAILS run). */
export const DEFAULT_CLUB = () => process.env.CLUB_ID ?? "a5";

/** Site owners. Falls back to the club admin list so an existing deployment keeps working unchanged. */
export const platformEmails = () => emailSet(process.env.PLATFORM_ADMIN_EMAILS || process.env.CLUB_ADMIN_EMAILS);

export type ClubColors = { primary: string; accent: string };
export type ClubLink = { label: string; url: string };
export type Club = { clubId: string; name: string; short: string; colors: ClubColors; links: ClubLink[]; notes: string };

/** The site's original navy and red. */
export const DEFAULT_COLORS: ClubColors = { primary: "#15294D", accent: "#C8323E" };

/** What the original club showed on Team Info before club settings existed. Written once, then edited in the app. */
const ORIGINAL: Record<string, Omit<Club, "clubId">> = {
  a5: {
    name: "A5 Volleyball", short: "A5", colors: DEFAULT_COLORS, notes: "",
    links: [
      { label: "A5 registration & player-parent contract", url: "https://a5volleyball.sprocketsports.com/" },
      { label: "SRVA / USAV membership", url: "https://www.srva.org/" },
      { label: "SportWrench tournament tickets", url: "https://sportwrench.com/" },
      { label: "A5 club tournaments", url: "https://www.a5tournaments.com/club-tournaments" }
    ]
  }
};

export function toClub(item: Record<string, unknown>): Club {
  const c = (item.colors ?? {}) as Partial<ClubColors>;
  return {
    clubId: String(item.clubId ?? String(item.PK ?? "").replace(/^CLUB#/, "")),
    name: String(item.name ?? ""),
    short: String(item.short ?? ""),
    colors: { primary: c.primary || DEFAULT_COLORS.primary, accent: c.accent || DEFAULT_COLORS.accent },
    links: Array.isArray(item.links) ? (item.links as ClubLink[]) : [],
    notes: String(item.notes ?? "")
  };
}

/** Writes the default club's record the first time anyone needs it. */
async function seedDefault(clubId: string): Promise<Club> {
  const base = ORIGINAL[clubId] ?? { name: process.env.CLUB_NAME || clubId.toUpperCase(), short: "", colors: DEFAULT_COLORS, links: [], notes: "" };
  const at = new Date().toISOString();
  const club: Club = { clubId, ...base };
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.club(clubId), type: "Club", ...club, createdAt: at, updatedAt: at }, ConditionExpression: "attribute_not_exists(PK)" }));
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubDir(clubId), type: "ClubDir", clubId, name: club.name, createdAt: at } }));
  } catch (e) {
    if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    const again = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.club(clubId) }));
    if (again.Item) return toClub(again.Item);
  }
  return club;
}

/** Clubs by id. Unknown ids are left out, except the default club, which is created on first use. */
export async function getClubs(ids: string[]): Promise<Map<string, Club>> {
  const out = new Map<string, Club>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: unique.slice(i, i + 100).map(keys.club) } } }));
    for (const it of res.Responses?.[TABLE] ?? []) { const c = toClub(it); out.set(c.clubId, c); }
  }
  if (unique.includes(DEFAULT_CLUB()) && !out.has(DEFAULT_CLUB())) out.set(DEFAULT_CLUB(), await seedDefault(DEFAULT_CLUB()));
  return out;
}

export async function getClub(clubId: string): Promise<Club | null> {
  return (await getClubs([clubId])).get(clubId) ?? null;
}

// A team never changes club, so a warm Lambda can remember the answer.
const teamClubCache = new Map<string, string>();

/** Which club each team belongs to. */
export async function clubsOfTeams(teamIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing = [...new Set(teamIds)].filter((t) => { const c = teamClubCache.get(t); if (c) out.set(t, c); return !c; });
  for (let i = 0; i < missing.length; i += 100) {
    const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: missing.slice(i, i + 100).map(keys.teamClub), ProjectionExpression: "PK, clubId" } } }));
    for (const it of res.Responses?.[TABLE] ?? []) {
      const t = String(it.PK).slice(5);
      teamClubCache.set(t, String(it.clubId));
      out.set(t, String(it.clubId));
    }
  }
  for (const t of missing) if (!out.has(t)) out.set(t, DEFAULT_CLUB());
  return out;
}

export async function clubOfTeam(teamId: string): Promise<string> {
  return (await clubsOfTeams([teamId])).get(teamId)!;
}

/** For tests. */
export const forgetTeamClubs = () => teamClubCache.clear();
