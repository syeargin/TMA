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
process.env.MFA_CHECK ??= "off"; // no user pool locally; run with MFA_CHECK=on to see the two-step prompts

const { freshTable, event } = await import("../test/api/harness.js");
const { handler } = await import("../src/api/handler.js");
const { ddb, TABLE } = await import("../src/lib/db.js");
const { keys } = await import("../src/lib/keys.js");
const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
const { setMfaLookup } = await import("../src/lib/mfa.js");

const OWNER = "u-owner", MOM = "u-mom";
const api = async (m: string, p: string, sub: string, b?: unknown, email = "") => {
  const r = await handler(event(m, p, sub, b, email));
  if ((r.statusCode ?? 0) >= 300) throw new Error(`${m} ${p} → ${r.statusCode} ${r.body}`);
  return r;
};

await freshTable();
// Seed as a site owner with two-step sign-in on, then go back to MFA_CHECK for browsing.
setMfaLookup(async () => true);
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
// A second club admin, so the club page lists someone with two-step status and a reset button.
await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin("test", "u-kim"), ...keys.clubAdminGsi("test", "u-kim"), type: "ClubAdmin", clubId: "test", sub: "u-kim", email: "kim@example.com", firstName: "Kim", lastName: "Lee", at: new Date().toISOString() } }));
await api("POST", "/teams/test-12/archive", OWNER);
// test-13 is on the old weekly practice times (converted when a coach opens it) and has practice uniform colors.
await api("PUT", "/teams/test-13/settings", OWNER, { teamName: "Test 13", season: "2026-27", age: "13U", coaches: [], practiceColors: ["Navy", "White", "Red"] });
await api("PUT", "/teams/test-13/practices", OWNER, { practices: [{ id: "wed", label: "Wednesday practice", dow: 3, start: "6:30 PM", end: "8:30 PM", from: "2026-10-07", until: "2027-03-31", location: "Test Gym" }] });
await api("PUT", "/teams/test-13/practices/cancelled/pr-wed-2026-10-21", OWNER);
await api("PUT", "/teams/test-13/family/p1", MOM, { rsvp: { "pr-wed-2026-10-14": "yes" } });
// Two more families, so a parent sees what others share (R3): one shares contacts, one doesn't.
await api("PUT", "/teams/test-13/events/e1", OWNER, { kind: "tournament", title: "Fall Classic", date: "2026-11-14", endDate: "2026-11-15", city: "Columbus, OH", travel: true });
const DAD = "u-dad", GRAN = "u-gran";
await api("PUT", "/teams/test-13/players/p1", OWNER, { first: "Ava", last: "Stone", jersey: "7", allergies: "Peanuts", parents: [{ name: "Mia Stone", cell: "555-0107", email: "mom@example.com" }] });
await api("PUT", "/teams/test-13/players/p2", OWNER, { first: "Bea", last: "Park", jersey: "11", allergies: "Shellfish", parents: [{ name: "Dan Park", cell: "555-0111", email: "dad@example.com" }] });
await api("PUT", "/teams/test-13/players/p3", OWNER, { first: "Cam", last: "Ruiz", jersey: "4", parents: [{ name: "Gloria Ruiz", cell: "555-0104", email: "gran@example.com" }] });
for (const [sub, pid, email] of [[DAD, "p2", "dad@example.com"], [GRAN, "p3", "gran@example.com"]]) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("test-13", sub), ...keys.memberGsi("test-13", sub), type: "Membership", status: "active", sub, roles: ["parent"], pid, email, at: new Date().toISOString() } }));
}
await api("PUT", "/teams/test-13/family/p2", DAD, { shareContacts: true, travel: { e1: { mode: "Flying", flight: "DL 1234", hotel: "Grand Hotel", conf: "QX7Z2" } }, uniform: { sizes: { "0": "M" } } });
await api("PUT", "/teams/test-13/settings", OWNER, { teamName: "Test 13", season: "2026-27", age: "13U", coaches: [], practiceColors: ["Navy", "White", "Red"], dues: { amountCents: 30000, due: "2026-11-01" } });
for (const [lid, pid, kind, cat, amountCents] of [["l1", "p1", "in", "Dues", 30000], ["l2", "p2", "in", "Dues", 15000], ["l3", "", "out", "Team meals", 8500]] as const) {
  await api("PUT", `/teams/test-13/ledger/${lid}`, OWNER, { kind, cat, ...(pid ? { pid } : {}), amountCents, date: "2026-10-05", desc: kind === "in" ? "Dues" : "Pizza after practice" });
}

// Everyone but Gloria (u-gran) has accepted the privacy notice, so she shows the consent page.
const { PRIVACY_VERSION } = await import("../src/shared/privacy.js");
for (const sub of [OWNER, MOM, "u-dad"]) await api("PUT", "/me/privacy", sub, { version: PRIVACY_VERSION });
setMfaLookup();

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
    const email = ({ [OWNER]: "owner@example.com", "u-dad": "dad@example.com", "u-gran": "gran@example.com", "u-kim": "kim@example.com" } as Record<string, string>)[sub] ?? "mom@example.com";
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
