/**
 * Calendar links hold a secret token (anyone with the link can read the schedule), so they're stored
 * encrypted (AES-256-GCM), tied to their team so a copied value can't be used on another team. The
 * key is made on first use and kept in the table (SECRET/FEED), like the email-link signing key. The
 * stored value says which key made it ("t1:"), so it can move to a KMS key later without losing links.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";

const KEY = { PK: "SECRET", SK: "FEED" };
let cached: Buffer | undefined;

async function key(): Promise<Buffer> {
  if (cached) return cached;
  const got = (await ddb.send(new GetCommand({ TableName: TABLE, Key: KEY }))).Item;
  if (got?.key) return (cached = Buffer.from(String(got.key), "base64"));
  const fresh = randomBytes(32).toString("base64");
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...KEY, type: "Secret", key: fresh, createdAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(PK)" }));
    return (cached = Buffer.from(fresh, "base64"));
  } catch {
    const again = (await ddb.send(new GetCommand({ TableName: TABLE, Key: KEY }))).Item;
    return (cached = Buffer.from(String(again!.key), "base64"));
  }
}

/** Tests start each table fresh. */
export function forgetFeedKey() { cached = undefined; }

export async function sealLink(link: string, teamId: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", await key(), iv);
  c.setAAD(Buffer.from(`feed:${teamId}`));
  const body = Buffer.concat([c.update(link, "utf8"), c.final()]);
  return `t1:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}

export async function openLink(sealed: string, teamId: string): Promise<string> {
  if (!sealed.startsWith("t1:")) throw new Error("unknown feed link format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", await key(), raw.subarray(0, 12));
  d.setAAD(Buffer.from(`feed:${teamId}`));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
