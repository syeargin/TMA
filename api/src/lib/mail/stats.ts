/**
 * Delivery health (Messaging M3). Delivery records live one per partition (DELIV#<id>), so a team's
 * numbers can't be read from them cheaply. Instead, every status change on a team's email also
 * updates a few small counters in the team's own stats partition, outside TEAM# so they never wake
 * the live-update fan-out:
 *
 *   MAILSTATS#<team> / DAY#<yyyy-mm-dd>#<msg>   sent, delivered, opened, bounced, complained, failed, next
 *   MAILSTATS#<team> / ADDR#<email>             one address: deliveries since its last open, bounces, complaints
 *   MAILSTATS#<team> / NEXT#<msg>#<pid>         an open "what happened next" for one family (answer, travel, pay)
 *
 * The day is the day the email was queued (UTC), so a delivery and its later open count on the same row.
 * Everything here expires with the delivery records (90 days); follow-ups after 14 days.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { normEmail } from "../keys.js";
import { RETENTION } from "../../shared/privacy.js";

export const statsPk = (teamId: string) => `MAILSTATS#${teamId}`;
export const FOLLOW_DAYS = 14;
/** What each follow-up counts, for the "What happened next" column. */
export const FOLLOWS = { availability: "answered", packet: "added travel plans", dues: "paid" } as const;
export type FollowMsg = keyof typeof FOLLOWS;

const ttl = (days: number = RETENTION.deliveryDays) => Math.floor(Date.now() / 1000) + days * 86400;
const isConditional = (e: unknown) => (e as { name?: string })?.name === "ConditionalCheckFailedException";
export const dayOf = (iso: string) => iso.slice(0, 10);

/** Fields on a delivery record that the counters need. */
export type DeliveryInfo = { id?: string; teamId?: string; msg?: string; to?: string; day?: string; createdAt?: string };

export type Counter = "sent" | "delivered" | "opened" | "bounced" | "complained" | "failed" | "next";

async function bump(teamId: string, day: string, msg: string, field: Counter) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: statsPk(teamId), SK: `DAY#${day}#${msg}` },
    UpdateExpression: "SET #t = :type, #d = :day, msg = :msg, #ttl = :ttl ADD #f :one",
    ExpressionAttributeNames: { "#t": "type", "#d": "day", "#ttl": "ttl", "#f": field },
    ExpressionAttributeValues: { ":type": "MailStats", ":day": day, ":msg": msg, ":ttl": ttl(), ":one": 1 }
  }));
}

/** What one address did, for Needs attention. */
async function touchAddress(teamId: string, to: string, msg: string, change: "delivered" | "opened" | "bounced" | "complained", detail = "") {
  const at = new Date().toISOString();
  const names: Record<string, string> = { "#t": "type", "#ttl": "ttl" };
  const values: Record<string, unknown> = { ":type": "MailAddress", ":to": normEmail(to), ":ttl": ttl(), ":at": at, ":msg": msg };
  const sets = ["#t = :type", "email = :to", "#ttl = :ttl", "lastMsg = :msg"];
  const adds: string[] = [];
  const removes: string[] = [];
  if (change === "delivered") {
    sets.push("lastDeliveredAt = :at");
    adds.push("delivered :one", "sinceOpen :one");
    // Mail is getting through again (they fixed a full mailbox, or the address was re-added).
    removes.push("bouncedAt", "bounceDetail");
  } else if (change === "opened") {
    sets.push("lastOpenAt = :at", "sinceOpen = :zero");
    values[":zero"] = 0;
  } else if (change === "bounced") {
    sets.push("bouncedAt = :at", "bounceDetail = :detail", "firstBounceAt = if_not_exists(firstBounceAt, :at)");
    values[":detail"] = detail;
    adds.push("bounces :one");
  } else {
    sets.push("complainedAt = :at");
  }
  if (adds.length) values[":one"] = 1;
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: statsPk(teamId), SK: `ADDR#${normEmail(to)}` },
    UpdateExpression: `SET ${sets.join(", ")}${adds.length ? " ADD " + adds.join(", ") : ""}${removes.length ? " REMOVE " + removes.join(", ") : ""}`,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values
  }));
}

/**
 * Counts one status change on a team email. Never throws: the counters are a view, and a failure
 * here mustn't stop an email or its status.
 */
export async function countStatus(d: DeliveryInfo, status: string, detail = ""): Promise<void> {
  if (!d.teamId || !d.msg || d.msg.startsWith("test")) return;
  const day = d.day || dayOf(d.createdAt ?? new Date().toISOString());
  try {
    if (status === "sent" || status === "delivered" || status === "bounced" || status === "complained" || status === "failed") await bump(d.teamId, day, d.msg, status);
    if (d.to && (status === "delivered" || status === "bounced" || status === "complained")) await touchAddress(d.teamId, d.to, d.msg, status, detail);
  } catch (e) {
    console.error(JSON.stringify({ msg: "mail stats failed", teamId: d.teamId, status, error: String(e) }));
  }
}

/** The first open of a delivery. Mail apps that load images count; ones that block them don't. */
export async function countOpen(d: DeliveryInfo): Promise<void> {
  if (!d.teamId || !d.msg) return;
  try {
    await bump(d.teamId, d.day || dayOf(d.createdAt ?? new Date().toISOString()), d.msg, "opened");
    if (d.to) await touchAddress(d.teamId, d.to, d.msg, "opened");
  } catch (e) {
    console.error(JSON.stringify({ msg: "mail stats failed", teamId: d.teamId, status: "opened", error: String(e) }));
  }
}

// ---------- what happened next ----------

const followKey = (teamId: string, msg: FollowMsg, pid: string) => ({ PK: statsPk(teamId), SK: `NEXT#${msg}#${pid}` });

/**
 * A family was just asked to do something (answer these dates, add travel for this tournament, pay
 * dues). When they do it within two weeks, the send's "What happened next" goes up by one.
 */
export async function startFollow(teamId: string, msg: FollowMsg, pid: string, about: string[], day = dayOf(new Date().toISOString())): Promise<void> {
  if (!pid) return;
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { ...followKey(teamId, msg, pid), type: "MailFollow", msg, pid, about, day, ttl: ttl(FOLLOW_DAYS) }
    }));
  } catch (e) {
    console.error(JSON.stringify({ msg: "mail follow failed", teamId, error: String(e) }));
  }
}

/** The family did it. `key` is the date, tournament or nothing (dues); it has to be one they were asked about. */
export async function completeFollow(teamId: string, msg: FollowMsg, pid: string, keys: string[] = []): Promise<boolean> {
  if (!pid) return false;
  try {
    const f = (await ddb.send(new GetCommand({ TableName: TABLE, Key: followKey(teamId, msg, pid) }))).Item;
    if (!f || Number(f.ttl ?? 0) < Date.now() / 1000) return false;
    const about = (f.about as string[] | undefined) ?? [];
    if (about.length && !keys.some((k) => about.includes(k))) return false;
    // Only the first change counts, however many requests arrive at once.
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: followKey(teamId, msg, pid), ConditionExpression: "#d = :d", ExpressionAttributeNames: { "#d": "day" }, ExpressionAttributeValues: { ":d": f.day } }));
    await bump(teamId, String(f.day), msg, "next");
    return true;
  } catch (e) {
    if (!isConditional(e)) console.error(JSON.stringify({ msg: "mail follow failed", teamId, error: String(e) }));
    return false;
  }
}

/** Follow-up changes from a family's save: answers and travel plans. Never throws. */
export async function familyChanged(teamId: string, pid: string, change: { rsvp?: string[]; travel?: string[] }): Promise<void> {
  if (change.rsvp?.length) await completeFollow(teamId, "availability", pid, change.rsvp);
  if (change.travel?.length) await completeFollow(teamId, "packet", pid, change.travel);
}
