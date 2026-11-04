/**
 * Questions, problem reports and ideas people send from the site.
 *
 *   FB#<id> / META   the message, who sent it, where from, status and replies (kept a year)
 *   FB#<id> / SHOT   an optional screenshot (JPEG/PNG/WebP, base64; kept 60 days)
 *     GSI1 FEEDBACK / <createdAt>#<id>       the site owners' inbox, newest first
 *     GSI2 USER#<sub>#FB / <createdAt>       what a signed-in person has sent (Account page)
 *   COUNTER / FEEDBACK                        the next reference number (TH-1001, TH-1002…)
 *   FBRATE#<who> / <day>                      sends per person per day (spam guard, kept 2 days)
 *   PLATFORM / FBSET#<sub>                    a site owner's own settings: copies of team questions, email for new items
 *
 * A question about the team goes to its coordinators by email (Reply-To the family); everything else
 * comes to site owners. Each site owner chooses whether they also get team questions.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import { keys } from "./keys.js";
import { queryAll } from "../api/util.js";

export const SHOT_DAYS = 60;
export const KEEP_DAYS = 365;
export const DAILY_LIMIT = 10;
export const KINDS = ["question", "problem", "idea"] as const;
/** What people send from the site, plus "inquiry": a club or team asking about Teem Hub (the front page's Talk to us). */
export type Kind = (typeof KINDS)[number] | "inquiry";
export const INQUIRY_ROLES = ["club", "team", "parent"] as const;
export const TEAM_COUNTS = ["1", "2-9", "10-39", "40+"] as const;
export type Inquiry = {
  role: (typeof INQUIRY_ROLES)[number]; org: string; sport: string; teams?: (typeof TEAM_COUNTS)[number];
  coordinatorEmail?: string; source?: string;
};
export const STATUSES = ["new", "waiting", "planned", "closed"] as const;
export type Status = (typeof STATUSES)[number];
export type Route = "team" | "teemhub";

export type Reply = { at: string; by: string; byName: string; message: string };
export type Feedback = {
  id: string; ref: string; kind: Kind; route: Route; status: Status; message: string;
  sub?: string; email: string; name: string;
  teamId?: string; teamName?: string; clubId?: string; roles?: string[];
  page?: { path: string; title: string }; error?: { code: string; message: string; at: string };
  device?: string; version?: string; hasShot: boolean; ownerCopy: boolean;
  createdAt: string; updatedAt: string; firstReplyAt?: string; replies: Reply[];
  /** Who it went to, for team questions (coordinators' names). */
  sentTo?: string[];
  /** Club and team inquiries from the front page. */
  inquiry?: Inquiry;
};
export type OwnerSettings = { teamQuestions: boolean; emailNew: boolean };

export const metaKey = (id: string) => ({ PK: `FB#${id}`, SK: "META" });
export const shotKey = (id: string) => ({ PK: `FB#${id}`, SK: "SHOT" });
const settingsKey = (sub: string) => ({ PK: "PLATFORM", SK: `FBSET#${sub}` });
const ttl = (days: number) => Math.floor(Date.now() / 1000) + days * 86400;

/** The next reference number: TH-1001 and up. */
export async function nextRef(): Promise<string> {
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: "COUNTER", SK: "FEEDBACK" },
    UpdateExpression: "ADD n :one", ExpressionAttributeValues: { ":one": 1 }, ReturnValues: "UPDATED_NEW"
  }));
  return `TH-${1000 + Number(r.Attributes?.n ?? 1)}`;
}

/** Counts a send; false once someone has sent DAILY_LIMIT today. */
export async function underLimit(who: string, at = new Date()): Promise<boolean> {
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `FBRATE#${who}`, SK: at.toISOString().slice(0, 10) },
    UpdateExpression: "ADD n :one SET #t = :t", ExpressionAttributeNames: { "#t": "ttl" },
    ExpressionAttributeValues: { ":one": 1, ":t": ttl(2) }, ReturnValues: "UPDATED_NEW"
  }));
  return Number(r.Attributes?.n ?? 0) <= DAILY_LIMIT;
}

export async function save(f: Feedback, shot?: { mime: string; data: string }) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...metaKey(f.id), type: "Feedback", ...f, ttl: ttl(KEEP_DAYS),
      GSI1PK: "FEEDBACK", GSI1SK: `${f.createdAt}#${f.id}`,
      ...(f.sub ? { GSI2PK: `USER#${f.sub}#FB`, GSI2SK: f.createdAt } : {})
    }
  }));
  if (shot) await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...shotKey(f.id), type: "FeedbackShot", ...shot, ttl: ttl(SHOT_DAYS) } }));
}

export async function get(id: string): Promise<Feedback | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: metaKey(id) }));
  return (r.Item as Feedback | undefined) ?? null;
}

/** The screenshot as a data URL, or null once it has expired (60 days). */
export async function shotOf(id: string): Promise<string | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: shotKey(id) }));
  const it = r.Item;
  if (!it || (typeof it.ttl === "number" && it.ttl * 1000 < Date.now())) return null;
  return `data:${it.mime};base64,${it.data}`;
}

export async function update(id: string, set: Partial<Feedback>) {
  const names = Object.keys(set);
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: metaKey(id), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: "SET " + names.map((n, i) => `#n${i} = :v${i}`).join(", "),
    ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#n${i}`, n])),
    ExpressionAttributeValues: Object.fromEntries(names.map((n, i) => [`:v${i}`, (set as Record<string, unknown>)[n]]))
  }));
}

/** The inbox: everything from the last year, newest first (small: a few a day at most). */
export async function all(): Promise<Feedback[]> {
  const rows = await queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :p", ExpressionAttributeValues: { ":p": "FEEDBACK" }, ScanIndexForward: false });
  return rows as unknown as Feedback[];
}

export async function mine(sub: string): Promise<Feedback[]> {
  const rows = await queryAll({ IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :p", ExpressionAttributeValues: { ":p": `USER#${sub}#FB` }, ScanIndexForward: false });
  return rows as unknown as Feedback[];
}

/** Everything someone sent, for deleting their account. */
export async function keysOf(sub: string): Promise<{ PK: string; SK: string }[]> {
  return (await mine(sub)).flatMap((f) => [metaKey(f.id), shotKey(f.id)]);
}

export async function settingsOf(sub: string): Promise<OwnerSettings> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: settingsKey(sub) }));
  return { teamQuestions: r.Item?.teamQuestions === true, emailNew: r.Item?.emailNew !== false };
}
export async function saveSettings(sub: string, s: OwnerSettings) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...settingsKey(sub), type: "FeedbackSettings", ...s } }));
}
export const deleteSettings = (sub: string) => ddb.send(new DeleteCommand({ TableName: TABLE, Key: settingsKey(sub) }));

/** Site owners, with their email and settings. */
export async function owners(): Promise<{ sub: string; email: string; firstName: string; settings: OwnerSettings }[]> {
  const rows = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :a)", ExpressionAttributeValues: { ":p": "PLATFORM", ":a": "ADMIN#" } });
  const out = [];
  for (const r of rows) {
    const sub = String(r.SK).slice(6);
    const profile = (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.profile(sub) }))).Item;
    const email = String(profile?.email ?? "");
    if (email) out.push({ sub, email, firstName: String(profile?.firstName ?? ""), settings: await settingsOf(sub) });
  }
  return out;
}

/** "Problem", "Team question"… */
export const label = (f: Pick<Feedback, "kind" | "route" | "inquiry">) =>
  f.kind === "inquiry" ? (f.inquiry?.role === "club" ? "Club inquiry" : "Team inquiry")
    : f.route === "team" ? "Team question" : f.kind === "question" ? "Question" : f.kind === "problem" ? "Problem" : "Idea";
