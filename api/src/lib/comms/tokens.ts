/**
 * Signed links in emails: one-click unsubscribe (Messaging M2). The token says who, which team and
 * which message, and is signed with a key kept in the table (SECRET/MAIL, made on first use), so a
 * link can't be changed to unsubscribe someone else. Unsubscribe links don't expire.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";

const KEY = { PK: "SECRET", SK: "MAIL" };
let secret: Buffer | undefined;

async function key(): Promise<Buffer> {
  if (secret) return secret;
  const got = (await ddb.send(new GetCommand({ TableName: TABLE, Key: KEY }))).Item;
  if (got?.key) return (secret = Buffer.from(String(got.key), "base64"));
  const fresh = randomBytes(32).toString("base64");
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...KEY, type: "Secret", key: fresh, createdAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(PK)" }));
    return (secret = Buffer.from(fresh, "base64"));
  } catch {
    // Made at the same moment by another request: use theirs.
    const again = (await ddb.send(new GetCommand({ TableName: TABLE, Key: KEY }))).Item;
    return (secret = Buffer.from(String(again!.key), "base64"));
  }
}

/** Tests start each table fresh. */
export function forgetKey() { secret = undefined; }

export type Unsub = { sub: string; teamId: string; msg: string };

const b64 = (b: Buffer) => b.toString("base64url");

export async function signUnsub(u: Unsub): Promise<string> {
  const body = b64(Buffer.from(JSON.stringify({ s: u.sub, t: u.teamId, m: u.msg, v: 1 })));
  const sig = b64(createHmac("sha256", await key()).update(`unsub.${body}`).digest());
  return `${body}.${sig}`;
}

export async function readUnsub(token: string): Promise<Unsub | null> {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig || body.length > 400) return null;
  const want = createHmac("sha256", await key()).update(`unsub.${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.s !== "string" || typeof p.t !== "string" || typeof p.m !== "string") return null;
    return { sub: p.s, teamId: p.t, msg: p.m };
  } catch { return null; }
}

// ---------- one-tap answers (availability reminder) ----------

/** One answer for one player on one date: In, Maybe or Out. Expires the day after the event. */
export type Answer = { sub: string; teamId: string; pid: string; key: string; v: "yes" | "maybe" | "no"; exp: number };

export async function signAnswer(a: Answer): Promise<string> {
  const body = b64(Buffer.from(JSON.stringify({ s: a.sub, t: a.teamId, p: a.pid, k: a.key, v: a.v, e: a.exp })));
  const sig = b64(createHmac("sha256", await key()).update(`answer.${body}`).digest());
  return `${body}.${sig}`;
}

export async function readAnswer(token: string, nowSec = Date.now() / 1000): Promise<Answer | "expired" | null> {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig || body.length > 600) return null;
  const want = createHmac("sha256", await key()).update(`answer.${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (![p.s, p.t, p.p, p.k].every((x) => typeof x === "string") || !["yes", "maybe", "no"].includes(p.v) || typeof p.e !== "number") return null;
    if (p.e < nowSec) return "expired";
    return { sub: p.s, teamId: p.t, pid: p.p, key: p.k, v: p.v, exp: p.e };
  } catch { return null; }
}
