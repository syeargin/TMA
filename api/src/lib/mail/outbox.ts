/**
 * Sending email (Messaging M1). A route queues a message: one delivery record per message per
 * person, whose id comes from a "dedupe" key, so the same message can only be queued once. The
 * sender (a separate Lambda in AWS, inline in tests and the local preview) renders it and hands it to
 * SES. SES's delivery, bounce and complaint events come back through EventBridge (jobs/mail-events.ts)
 * and update the record and the item it's about, like the invite's "Delivered" or "Bounced".
 *
 * Delivery records live in their own partitions (DELIV#<id>), outside TEAM#, so they never wake the
 * live-update fan-out, and DynamoDB deletes them after 90 days (privacy notice).
 */
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { ddb, TABLE } from "../db.js";
import { normEmail } from "../keys.js";
import type { EmailStatus } from "../../shared/messages.js";
import { RETENTION } from "../../shared/privacy.js";
import { render, type LiveMessage, type MailData } from "./templates.js";

export const DELIVERY_DAYS = RETENTION.deliveryDays;
export const deliveryKey = (id: string) => ({ PK: `DELIV#${id}`, SK: "META" });

/** The item a delivery is about (an invite), which shows its email status. */
export type Link = { PK: string; SK: string };

export type QueueInput<K extends LiveMessage> = {
  msg: K; to: string; data: MailData[K];
  /** Same key, same delivery: queuing twice sends once. */
  dedupe: string;
  teamId?: string; clubId?: string; link?: Link; by?: string;
};

const deliveryId = (dedupe: string) => createHash("sha256").update(dedupe).digest("hex").slice(0, 32);
const isConditional = (e: unknown) => (e as { name?: string })?.name === "ConditionalCheckFailedException";

/** Records the message as waiting to send. Returns its id, and whether it was new. */
export async function queueEmail<K extends LiveMessage>(q: QueueInput<K>): Promise<{ id: string; queued: boolean }> {
  const id = deliveryId(q.dedupe);
  const at = new Date().toISOString();
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)",
      Item: {
        ...deliveryKey(id), type: "Delivery", id, msg: q.msg, channel: "email", to: normEmail(q.to), data: q.data,
        status: "queued", link: q.link, teamId: q.teamId, clubId: q.clubId, by: q.by,
        createdAt: at, ttl: Math.floor(Date.now() / 1000) + DELIVERY_DAYS * 86400
      }
    }));
  } catch (e) {
    if (isConditional(e)) return { id, queued: false };
    throw e;
  }
  if (q.link) await markLink(q.link, "queued", at, { id, first: true });
  return { id, queued: true };
}

/** Shows the latest email status on the linked item. Does nothing if the item is gone (an accepted invite). */
async function markLink(link: Link, status: EmailStatus, at: string, opts: { id?: string; first?: boolean; detail?: string } = {}) {
  const sets = ["emailStatus = :s", "emailStatusAt = :a"];
  const values: Record<string, unknown> = { ":s": status, ":a": at };
  if (opts.first) { sets.push("emailAt = :a", "emailDelivery = :d"); values[":d"] = opts.id; }
  sets.push("emailDetail = :x");
  values[":x"] = opts.detail ?? "";
  // A later event about an older email (a bounce for the first invite after a resend) doesn't overwrite the newer one.
  const cond = opts.first || !opts.id ? "attribute_exists(PK)" : "attribute_exists(PK) AND emailDelivery = :d";
  if (!opts.first && opts.id) values[":d"] = opts.id;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: link, ConditionExpression: cond,
      UpdateExpression: `SET ${sets.join(", ")}${opts.first ? " ADD emailCount :one" : ""}`,
      ExpressionAttributeValues: { ...values, ...(opts.first ? { ":one": 1 } : {}) }
    }));
  } catch (e) {
    if (!isConditional(e)) throw e;
  }
}

// ---------- handing records to the sender ----------

let lambda: LambdaClient | undefined;

/** Starts sending. In AWS that's the sender function, called without waiting; elsewhere, right here. */
export async function dispatch(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const fn = process.env.MAIL_SENDER_FUNCTION;
  if (!fn) { await sendDeliveries(ids); return; }
  lambda ??= new LambdaClient({});
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    try {
      await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ ids: chunk })) }));
    } catch (e) {
      console.error(JSON.stringify({ msg: "mail dispatch failed", ids: chunk, error: String(e) }));
      for (const id of chunk) await setStatus(id, "failed", "Couldn't start sending. Try again.");
    }
  }
}

// ---------- the sender ----------

export type Mail = { to: string; fromName: string; subject: string; html: string; text: string; tags: Record<string, string> };
export interface Transport { send(m: Mail): Promise<string> }

/** Tests and the local preview (MAIL_TRANSPORT=memory) collect mail here instead of sending it. */
export const memoryOutbox: Mail[] = [];
const memory: Transport = { async send(m) { memoryOutbox.push(m); return `mem-${memoryOutbox.length}`; } };

let ses: SESv2Client | undefined;

/** RFC 2047 for names with accents, quotes stripped: "A5 13 Tom via Teem Hub" <noreply@teemhub.net>. */
export function fromHeader(name: string, address: string): string {
  const clean = name.replace(/["\\\r\n<>]/g, "").trim() || "Teem Hub";
  const display = /^[\x20-\x7E]*$/.test(clean) ? `"${clean}"` : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
  return `${display} <${address}>`;
}

const sesTransport = (from: string): Transport => ({
  async send(m) {
    ses ??= new SESv2Client({});
    const res = await ses.send(new SendEmailCommand({
      FromEmailAddress: fromHeader(m.fromName, from),
      Destination: { ToAddresses: [m.to] },
      Content: { Simple: {
        Subject: { Data: m.subject, Charset: "UTF-8" },
        Body: { Html: { Data: m.html, Charset: "UTF-8" }, Text: { Data: m.text, Charset: "UTF-8" } }
      } },
      ConfigurationSetName: process.env.MAIL_CONFIG_SET || undefined,
      EmailTags: Object.entries(m.tags).map(([Name, Value]) => ({ Name, Value }))
    }));
    return res.MessageId ?? "";
  }
});

function transport(): Transport | null {
  if (process.env.MAIL_TRANSPORT === "memory") return memory;
  const from = process.env.MAIL_FROM;
  return from ? sesTransport(from) : null;
}

const env = () => process.env.APP_ENV ?? "";

async function setStatus(id: string, status: EmailStatus, detail = "", extra: Record<string, unknown> = {}) {
  const at = new Date().toISOString();
  const names = Object.keys(extra);
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: deliveryKey(id), ReturnValues: "ALL_NEW",
    UpdateExpression: `SET #s = :s, statusAt = :a, detail = :d${names.map((n, i) => `, #x${i} = :x${i}`).join("")}`,
    ExpressionAttributeNames: { "#s": "status", ...Object.fromEntries(names.map((n, i) => [`#x${i}`, n])) },
    ExpressionAttributeValues: { ":s": status, ":a": at, ":d": detail, ...Object.fromEntries(names.map((n, i) => [`:x${i}`, extra[n]])) }
  }));
  const link = res.Attributes?.link as Link | undefined;
  if (link) await markLink(link, status, at, { id, detail });
}

/** Sends each queued delivery once. Safe to run twice: only "queued" records are claimed. */
export async function sendDeliveries(ids: string[]): Promise<{ sent: number; failed: number; skipped: number }> {
  const t = transport();
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const id of ids) {
    const item = (await ddb.send(new GetCommand({ TableName: TABLE, Key: deliveryKey(id) }))).Item;
    if (!item || item.status !== "queued") continue;
    // Claim it, so a retried invocation running at the same time doesn't send it as well.
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: deliveryKey(id), ConditionExpression: "#s = :q",
        UpdateExpression: "SET #s = :c, statusAt = :a", ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":q": "queued", ":c": "sending", ":a": new Date().toISOString() }
      }));
    } catch (e) {
      if (isConditional(e)) continue;
      throw e;
    }
    if (!t) {
      await setStatus(id, "skipped", "Email isn't set up for this environment.");
      out.skipped++;
      continue;
    }
    try {
      const r = render(item.msg as LiveMessage, item.data as never);
      const suffix = env() && env() !== "prod" ? ` (${env()})` : "";
      const messageId = await t.send({
        to: String(item.to), fromName: r.fromName + suffix, subject: r.subject, html: r.html, text: r.text,
        tags: { env: env() || "local", delivery: id, msg: String(item.msg) }
      });
      await setStatus(id, "sent", "", { sesId: messageId, sentAt: new Date().toISOString() });
      out.sent++;
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      console.error(JSON.stringify({ msg: "mail send failed", id, error: String(e) }));
      // Throttling and outages: put it back so the sender's retry picks it up. Anything else is final.
      if (/Throttl|TooManyRequests|ServiceUnavailable|InternalFailure/.test(name)) {
        await ddb.send(new UpdateCommand({ TableName: TABLE, Key: deliveryKey(id), UpdateExpression: "SET #s = :q", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":q": "queued" } }));
        throw e;
      }
      await setStatus(id, "failed", name === "MessageRejected" ? "The address was refused." : "Couldn't send.");
      out.failed++;
    }
  }
  return out;
}

// ---------- events from SES ----------

const RANK: Record<string, number> = { queued: 0, sending: 0, sent: 1, delivered: 2, failed: 3, bounced: 3, complained: 4, skipped: 3 };

export type SesEvent = {
  eventType?: string;
  mail?: { tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bounceSubType?: string };
  reject?: { reason?: string };
};

/** One SES event (delivered, bounced, complaint, rejected) for a message we sent. */
export async function applySesEvent(e: SesEvent): Promise<EmailStatus | null> {
  const id = e.mail?.tags?.delivery?.[0];
  if (!id) return null;
  let status: EmailStatus | null = null;
  let detail = "";
  switch (e.eventType) {
    case "Delivery": status = "delivered"; break;
    case "Bounce":
      // Transient bounces (a full mailbox) are retried by SES; only a permanent one is final.
      if (e.bounce?.bounceType !== "Permanent") return null;
      status = "bounced";
      detail = e.bounce?.bounceSubType === "Suppressed"
        ? "This address bounced before, so it's on the do-not-send list. Cancel the invite and invite the right address."
        : "The address doesn't accept mail. Check it for a typo, then cancel the invite and invite the right address.";
      break;
    case "Complaint": status = "complained"; detail = "They marked it as spam. Ask before sending again."; break;
    case "Reject": status = "failed"; detail = "Refused before sending."; break;
    default: return null;
  }
  const item = (await ddb.send(new GetCommand({ TableName: TABLE, Key: deliveryKey(id) }))).Item;
  if (!item) return null;
  if ((RANK[String(item.status)] ?? 0) >= RANK[status]) return null;
  await setStatus(id, status, detail);
  console.log(JSON.stringify({ msg: "mail event", id, status, mailMsg: item.msg }));
  return status;
}
