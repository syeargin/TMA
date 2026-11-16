import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import { keys } from "./keys.js";
import { deleteMany, queryAll } from "../api/util.js";

type Key = { PK: string; SK: string };
type Row = Record<string, unknown>;

/** An answer, attendance or child key that belongs to the event: the event itself, or one of its dates ("<eid>-<date>"). */
const ofEvent = (eid: string) => (k: string) => k === eid || k.startsWith(`${eid}-`);

/** What's attached to an event, for the warning before it's removed. */
export type Attached = { answers: number; meals: number; matches: number; workMatches: number; refJobs: boolean; dayPlan: boolean; agenda: boolean; attendance: number };

export async function attachedTo(teamId: string, eid: string): Promise<Attached> {
  const mine = ofEvent(eid);
  const [children, families, att] = await Promise.all([
    queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": `EVENT#${eid}#` } }),
    queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :f)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":f": "FAMILY#" }, ProjectionExpression: "rsvp" }),
    queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :a)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":a": `ATT#${eid}` }, ProjectionExpression: "SK, marks" })
  ]);
  const sk = (r: Row) => String(r.SK).slice(`EVENT#${eid}#`.length);
  const doc = children.find((r) => sk(r) === "MATCHES") as Row | undefined;
  return {
    answers: families.reduce((n, f) => n + Object.keys((f.rsvp ?? {}) as Row).filter(mine).length, 0),
    meals: children.filter((r) => sk(r).startsWith("MEAL#")).length,
    matches: Object.keys((doc?.matches ?? {}) as Row).length,
    workMatches: Object.keys((doc?.work ?? {}) as Row).length,
    refJobs: children.some((r) => sk(r) === "REFJOBS" && Object.keys((r.assign ?? {}) as Row).length > 0),
    dayPlan: children.some((r) => sk(r) === "DAYPLAN"),
    agenda: children.some((r) => sk(r) === "AGENDA"),
    attendance: att.filter((r) => mine(String(r.SK).slice(4)) && Object.keys((r.marks ?? {}) as Row).length > 0).length
  };
}

/**
 * Removes an event for good: the event, everything stored under it (meals, matches, ref jobs, day plan,
 * agenda), its attendance and families' answers to it. The change history (FEEDLOG) stays.
 */
export async function removeEvent(teamId: string, eid: string): Promise<void> {
  const mine = ofEvent(eid);
  const [children, families, att] = await Promise.all([
    queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :s)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":s": `EVENT#${eid}#` }, ProjectionExpression: "PK, SK" }),
    queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :f)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":f": "FAMILY#" }, ProjectionExpression: "PK, SK, rsvp" }),
    queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :a)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":a": `ATT#${eid}` }, ProjectionExpression: "PK, SK" })
  ]);
  for (const f of families) {
    const rsvp = { ...((f.rsvp ?? {}) as Row) };
    const gone = Object.keys(rsvp).filter(mine);
    if (!gone.length) continue;
    for (const k of gone) delete rsvp[k];
    await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { PK: String(f.PK), SK: String(f.SK) }, UpdateExpression: "SET rsvp = :r", ExpressionAttributeValues: { ":r": rsvp } }));
  }
  const attKeys = (att as Key[]).filter((r) => mine(r.SK.slice(4)));
  await deleteMany([keys.event(teamId, eid), ...(children as Key[]), ...attKeys]);
}
