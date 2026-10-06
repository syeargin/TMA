/**
 * Local preview for screenshots: runs the real API handler against moto on :8000 and serves web/dist,
 * with a seeded site owner, a club and teams. Not used in production. Run from api/:
 *   npx vite-node scripts/preview-server.ts
 * The browser sends a fake access token; the sub is read from it unverified.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

process.env.TABLE_NAME = "TeamHub-preview";
process.env.CLUB_ID = "a5";
process.env.AWS_REGION ??= "us-east-1";
process.env.DYNAMODB_ENDPOINT ??= "http://127.0.0.1:8000";
process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";

const { freshTable, event } = await import("../test/api/harness.js");
const { handler } = await import("../src/api/handler.js");
const { ddb, TABLE } = await import("../src/lib/db.js");
const { keys } = await import("../src/lib/keys.js");
const { PutCommand } = await import("@aws-sdk/lib-dynamodb");

const OWNER = "u-owner", MOM = "u-mom";
const api = async (m: string, p: string, sub: string, b?: unknown, email = "") => {
  const r = await handler(event(m, p, sub, b, email));
  if ((r.statusCode ?? 0) >= 300) throw new Error(`${m} ${p} → ${r.statusCode} ${r.body}`);
  return r;
};

await freshTable();
await api("GET", "/me", OWNER, undefined, "owner@example.com");
await api("PUT", "/me", OWNER, { firstName: "Sam", lastName: "Owner" });
await api("POST", "/clubs", OWNER, { clubId: "test", name: "Test Club", short: "Test", colors: { primary: "#14532D", accent: "#9AD3A5" } });
for (const [id, name, age] of [["test-13", "Test 13", "13U"], ["test-14", "Test 14", "14U"], ["test-12", "Test 12 (2025-26)", "12U"]]) {
  await api("POST", "/teams", OWNER, { clubId: "test", teamId: id, name, age, season: id === "test-12" ? "2025-26" : "2026-27" });
  await api("PUT", `/teams/${id}/players/p1`, OWNER, { first: "Ava", last: "Stone", jersey: "7" });
  await api("PUT", `/teams/${id}/events/e1`, OWNER, { kind: "tournament", title: "Fall Classic", date: "2026-11-14" });
  await api("PUT", `/teams/${id}/announcements/a1`, OWNER, { text: "Welcome to the season!" });
}
await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("test-12", MOM), ...keys.memberGsi("test-12", MOM), type: "Membership", status: "active", sub: MOM, roles: ["parent"], pid: "p1", email: "mom@example.com", firstName: "Mia", at: new Date().toISOString() } }));
await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("test-13", MOM), ...keys.memberGsi("test-13", MOM), type: "Membership", status: "active", sub: MOM, roles: ["parent"], pid: "p1", email: "mom@example.com", firstName: "Mia", at: new Date().toISOString() } }));
await api("POST", "/teams/test-12/archive", OWNER);

const DIST = join(import.meta.dirname, "../../web/dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const subOf = (auth = "") => { try { return JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString()).sub as string; } catch { return ""; } };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
  if (url.pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const sub = subOf(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const email = sub === OWNER ? "owner@example.com" : "mom@example.com";
    const r = await handler(event(req.method!, url.pathname.slice(4), sub || null, body, email));
    res.writeHead(r.statusCode ?? 200, { ...cors, "content-type": "application/json" }).end(r.body ?? "");
    return;
  }
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ env: "preview", apiUrl: "http://127.0.0.1:4300/api", userPoolId: "us-east-1_preview", userPoolClientId: "previewclient", region: "us-east-1" }));
    return;
  }
  const file = join(DIST, url.pathname);
  const path = existsSync(file) && extname(file) ? file : join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(4300, "127.0.0.1", () => console.log("preview on http://127.0.0.1:4300"));
