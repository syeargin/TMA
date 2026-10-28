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
process.env.EMAIL_CHECK ??= "off"; // no user pool locally: trust the dev token's email
process.env.MFA_CHECK ??= "off"; // no user pool locally; run with MFA_CHECK=on to see the two-step prompts
process.env.MAIL_TRANSPORT ??= "memory"; // emails are collected, not sent
process.env.SITE_URL ??= "http://127.0.0.1:4300";
process.env.APP_ENV ??= "dev";

const { freshTable, event } = await import("../test/api/harness.js");
const { handler } = await import("../src/api/handler.js");
const { ddb, TABLE } = await import("../src/lib/db.js");
const { keys } = await import("../src/lib/keys.js");
const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
const { setMfaLookup } = await import("../src/lib/mfa.js");
// Calendar feed sync: no internet here, so every calendar link reads a made-up Sprocket-style calendar
// (a link with "google" in it reads the Google-style one instead).
const { setFeedFetcher, normalizeFeedUrl } = await import("../src/lib/feed/fetch.js");
setFeedFetcher(async (raw) => {
  const u = normalizeFeedUrl(raw);
  const file = raw.includes("google") ? "google-style.ics" : "sprocket-style.ics";
  return { body: readFileSync(join(import.meta.dirname, "../test/feed/fixtures", file), "utf8"), host: u.hostname, finalHost: u.hostname };
});

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

// Invites in each email state (Messaging M1): emailed and delivered, bounced, and imported without an email.
await api("POST", "/teams/test-13/invites", OWNER, { email: "coach.lee@example.com", firstName: "Lee", lastName: "Park", roles: ["coach"] });
await api("POST", "/teams/test-13/invites", OWNER, { email: "d.torres@gmial.com", roles: ["parent"], pid: "p3" });
await api("POST", "/teams/test-13/invites", OWNER, { email: "kim.ruiz@example.com", roles: ["parent"], pid: "p2", sendEmail: false });
await api("POST", "/teams/test-13/invites", OWNER, { email: "sam.ruiz@example.com", roles: ["parent"], pid: "p2", sendEmail: false });
{
  const { applySesEvent } = await import("../src/lib/mail/outbox.js");
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const delivery = async (email: string) => String((await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.invite(email, "test-13") }))).Item?.emailDelivery);
  await applySesEvent({ eventType: "Delivery", mail: { tags: { delivery: [await delivery("coach.lee@example.com")] } } });
  await applySesEvent({ eventType: "Bounce", bounce: { bounceType: "Permanent" }, mail: { tags: { delivery: [await delivery("d.torres@gmial.com")] } } });
}

// Messaging M2: the weekly email and staff digest on for test-13; a coach who isn't a parent.
await api("PUT", "/teams/test-13/comms", OWNER, { messages: { weekly: { on: true }, staffDigest: { on: true, time: "17:30" }, packet: { on: true }, availability: { on: true }, announcement: { on: true } } });
await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("test-13", "u-kim"), ...keys.memberGsi("test-13", "u-kim"), type: "Membership", status: "active", sub: "u-kim", roles: ["coach", "coordinator"], email: "kim@example.com", firstName: "Kim", at: new Date().toISOString() } }));
await api("PUT", "/teams/test-13/announcements/a2", OWNER, { text: "Warm-ups are in: pick them up after Wednesday's practice.", pinned: true });

// Messaging M3: a month of delivery numbers for the Delivery health tab. Dan (dad) stopped opening;
// Gloria turned team email off, and the invite for the Ruiz family bounced, so they're unreachable.
{
  const pk = "MAILSTATS#test-13";
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: pk, ...Item } }));
  for (const [i, n] of [3, 10, 17, 24].entries()) {
    await put({ SK: `DAY#${day(n)}#weekly`, type: "MailStats", day: day(n), msg: "weekly", sent: 18, delivered: 18 - (i === 0 ? 1 : 0), opened: 14 + i % 2, bounced: i === 0 ? 1 : 0 });
    await put({ SK: `DAY#${day(n + 2)}#availability`, type: "MailStats", day: day(n + 2), msg: "availability", sent: 5, delivered: 5, opened: 4, next: 4 });
  }
  await put({ SK: `DAY#${day(8)}#packet`, type: "MailStats", day: day(8), msg: "packet", sent: 18, delivered: 18, opened: 17, next: 6 });
  await put({ SK: `DAY#${day(5)}#announcement`, type: "MailStats", day: day(5), msg: "announcement", sent: 21, delivered: 21, opened: 16 });
  const at = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  await put({ SK: "ADDR#mom@example.com", type: "MailAddress", email: "mom@example.com", delivered: 9, sinceOpen: 0, lastDeliveredAt: at(3), lastOpenAt: at(3) });
  await put({ SK: "ADDR#dad@example.com", type: "MailAddress", email: "dad@example.com", delivered: 9, sinceOpen: 6, lastDeliveredAt: at(3), lastOpenAt: at(40) });
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member("test-13", GRAN), ...keys.memberGsi("test-13", GRAN), type: "Membership", status: "active", sub: GRAN, roles: ["parent"], pid: "p3", email: "gran@example.com", notifyOff: ["all"], at: new Date().toISOString() } }));
}

// Practice attendance: test-13 has Monday skills sessions since September, most of them taken, plus
// more players so the summary has rows. Today's practice is left for taking.
for (const [pid, first, last, jersey] of [["p4", "Dani", "Ortiz", "2"], ["p5", "Ella", "Moss", "9"], ["p6", "Fran", "Kim", "14"], ["p7", "Gia", "Lopez", "5"], ["p8", "Hana", "Reed", "12"]]) {
  await api("PUT", `/teams/test-13/players/${pid}`, OWNER, { first, last, jersey });
}
await api("PUT", "/teams/test-13/events/skills", OWNER, { kind: "practice", title: "Skills session", date: "2026-09-07", time: "6:00 PM", endTime: "7:30 PM", location: "Test Gym",
  repeat: { every: 1, days: [1], until: "2027-03-29" } });
{
  const marks: Record<string, string> = { p1: "PPAPPPLP", p2: "PPPPEPPP", p3: "PLPAPEPP", p4: "PPPPPPPP", p5: "PPEPPLPP", p6: "PAAPEAPL", p7: "PPPLPPPP", p8: "PPLPPPPP" };
  const letter: Record<string, string> = { P: "present", L: "late", E: "excused", A: "absent" };
  const mondays = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];
  for (const [i, d] of mondays.entries()) {
    if (d === "2026-09-28") continue; // one practice nobody marked
    const m = Object.fromEntries(Object.entries(marks).map(([pid, row]) => [pid, { s: letter[row[i]], ...(row[i] === "L" ? { note: "Arrived 6:20" } : {}) }]));
    await api("PUT", `/teams/test-13/attendance/skills-${d}`, OWNER, { marks: m });
  }
}

// Site admin dashboard: the test club has a limit of 2 active teams (it's full) and no text alerts;
// two more clubs, one of them inactive.
await api("PUT", "/admin/clubs/test", OWNER, { teamLimit: 2, features: { texts: false } });
await api("POST", "/clubs", OWNER, { clubId: "eastside", name: "Eastside VBC", short: "EVBC", colors: { primary: "#1F3A8A", accent: "#F59E0B" } });
for (const [id, name] of [["ev-14", "Eastside 14 Black"], ["ev-15", "Eastside 15 Gold"], ["ev-16", "Eastside 16 Black"]]) await api("POST", "/teams", OWNER, { clubId: "eastside", teamId: id, name, season: "2026-27" });
await api("PUT", "/admin/clubs/eastside", OWNER, { teamLimit: 6, features: { uniforms: false } });
await api("POST", "/clubs", OWNER, { clubId: "riverside", name: "Riverside Juniors", short: "RJ", colors: { primary: "#7F1D1D", accent: "#FCA5A5" } });
await api("POST", "/teams", OWNER, { clubId: "riverside", teamId: "rj-13", name: "Riverside 13", season: "2025-26" });
await api("PUT", "/admin/clubs/riverside", OWNER, { status: "inactive", reason: "Didn't renew for 2026-27" });

// Everyone but Gloria (u-gran) has accepted the privacy notice, so she shows the consent page.
const { PRIVACY_VERSION } = await import("../src/shared/privacy.js");
for (const sub of [OWNER, MOM, "u-dad", "u-kim"]) await api("PUT", "/me/privacy", sub, { version: PRIVACY_VERSION });
// Help guide screenshots (web/scripts/help-shots.mjs): a filled-in game-day sheet and hotel, meals,
// travel plans, answers for the skills session, and a dues payment waiting for finance.
await api("PUT", "/teams/test-13/events/e1", OWNER, { kind: "tournament", title: "Fall Classic", date: "2026-11-14", endDate: "2026-11-15", city: "Columbus, OH", travel: true,
  location: "Test Sportsplex", address: "100 Main St, Columbus, OH", arrival: "7:15 AM", start: "8:00 AM", waves: "Morning wave", meet: "Court 6, by the east doors", uniforms: "Navy jerseys, black shorts", teamCode: "T13BLUE",
  hotel: "Riverside Suites", hotelAddress: "20 River Rd, Columbus, OH", hotelCode: "TEST13", hotelBy: "Oct 30",
  checklist: ["Knee pads", "Water bottle", "Snacks for between matches"] });
await api("PUT", "/teams/test-13/events/e1/meals/m1", OWNER, { day: "2026-11-14", meal: "Lunch", time: "12:30 PM", plan: "Sandwiches and fruit for 12" });
await api("PUT", "/teams/test-13/events/e1/meals/m2", OWNER, { day: "2026-11-14", meal: "Dinner", time: "6:30 PM", plan: "Pasta night at the hotel", claimedBy: "p2" });
await api("PUT", "/teams/test-13/events/e1/meals/m3", OWNER, { day: "2026-11-15", meal: "Breakfast", time: "7:00 AM", plan: "Bagels and yogurt" });
await api("PUT", "/teams/test-13/family/p2", OWNER, { travel: { e1: { mode: "Driving", hotel: "Riverside Suites", arrive: "Fri evening" } } });
for (const [pid, v] of [["p1", "yes"], ["p2", "yes"], ["p4", "maybe"], ["p5", "no"], ["p6", "yes"]]) await api("PUT", `/teams/test-13/family/${pid}`, OWNER, { rsvp: { "skills-2026-10-26": v, "pr-wed-2026-10-28": v, "skills-2026-11-02": v } });
// A one-off practice with no time (as a spreadsheet's Schedule tab can leave it), for the "needs a time" reminder.
await api("PUT", "/teams/test-13/events/extra1", OWNER, { kind: "practice", title: "Extra serving practice", date: "2026-11-07", location: "Test Gym" });
await api("POST", "/teams/test-13/payments", MOM, { kind: "in", cat: "Dues", pid: "p1", amountCents: 15000, date: "2026-10-24", desc: "Second half of dues (Venmo)" });

// Match tracker and Stats: three finished tournaments with scores, and Mia as the Fall Classic's
// scorekeeper (nothing entered there yet).
{
  const tourneys: [string, string, string, string | undefined, [string, string, string, number, [number, number][]][]][] = [
    ["t-ld", "Labor Day Open", "2026-09-06", undefined, [
      ["8:00 AM", "3", "Lakeside 13 Gold", 3, [[25, 20], [25, 22]]], ["10:00 AM", "3", "Northside Elite 13", 3, [[18, 25], [21, 25]]],
      ["12:00 PM", "5", "River City 13", 3, [[25, 23], [19, 25], [12, 15]]], ["2:00 PM", "5", "Metro VBC 13 Red", 3, [[22, 25], [25, 21], [15, 13]]],
      ["4:00 PM", "5", "Hillcrest 13 Navy", 3, [[20, 25], [23, 25]]]]],
    ["t-ok", "October Kickoff", "2026-10-17", "2026-10-18", [
      ["8:00 AM", "2", "Westfield 13 Blue", 2, [[25, 17], [25, 19]]], ["9:00 AM", "2", "Lakeside 13 Gold", 2, [[25, 23], [26, 24]]],
      ["11:00 AM", "4", "Summit 13", 2, [[19, 25], [25, 21]]], ["9:00 AM", "1", "River City 13", 3, [[25, 21], [25, 18]]],
      ["11:00 AM", "1", "Northside Elite 13", 3, [[23, 25], [25, 22], [9, 15]]], ["1:00 PM", "1", "Valley 13 Black", 3, [[25, 16], [25, 20]]],
      ["3:00 PM", "1", "Crestview 13", 3, [[25, 22], [21, 25], [15, 12]]]]],
    ["t-hc", "Harvest Cup", "2026-10-24", "2026-10-25", [
      ["8:00 AM", "6", "Metro VBC 13 Red", 3, [[25, 21], [23, 25], [15, 11]]], ["10:00 AM", "6", "Pinecrest 13", 3, [[25, 18], [25, 20]]],
      ["12:00 PM", "4", "Hillcrest 13 Navy", 3, [[19, 25], [22, 25]]], ["9:00 AM", "2", "Westfield 13 Blue", 3, [[25, 23], [25, 22]]],
      ["11:00 AM", "2", "Summit 13", 3, [[21, 25], [25, 19], [13, 15]]]]]
  ];
  for (const [eid, title, date, endDate, ms] of tourneys) {
    await api("PUT", `/teams/test-13/events/${eid}`, OWNER, { kind: "tournament", title, date, ...(endDate ? { endDate } : {}), city: "Columbus, OH" });
    const days = endDate ? [date, endDate] : [date];
    let i = 0;
    for (const [time, court, opponent, format, sets] of ms) {
      // October Kickoff: 3 matches Saturday, 4 Sunday; the others 3 then the rest.
      const day = days.length === 1 ? days[0] : i < 3 ? days[0] : days[1];
      const n = days.length === 1 ? i + 1 : i < 3 ? i + 1 : i - 2;
      if (n > 3) await api("PUT", `/teams/test-13/events/${eid}/matchslots`, OWNER, { date: day, slots: n });
      const res = sets.filter(([a, b]) => a > b).length > sets.length / 2 ? "W" : sets.filter(([a, b]) => a > b).length * 2 === sets.length ? "L" : "";
      await api("PUT", `/teams/test-13/events/${eid}/matches/${day}-${n}`, OWNER, { time, court, opponent, format, sets: sets.map(([us, them]) => ({ us, them })), result: res });
      i++;
    }
  }
  await api("PUT", "/teams/test-13/events/e1/scorekeeper", OWNER, { sub: MOM });
}
setMfaLookup();

const DIST = join(import.meta.dirname, "../../web/dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".woff": "font/woff" };
// The site's CSP from template.yaml (R6), enforced here too so problems show up locally. Reports go to
// the real report handler and print below. Plain http locally, so no upgrade-insecure-requests.
// @ts-expect-error plain .mjs helper shared with CI
const { csp } = await import("../../scripts/check-csp.mjs");
const CSP = process.env.PREVIEW_CSP === "off" ? "" : (csp({ "CspReportFunctionUrl.FunctionUrl": "http://127.0.0.1:4300/csp-report" }) as string).replace(/\s*upgrade-insecure-requests;/, "");
const { handler: cspReport } = await import("../src/jobs/csp-report.js");
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
  if (url.pathname === "/csp-report") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await cspReport({ requestContext: { http: { method: req.method } }, headers: req.headers, body: Buffer.concat(chunks).toString() } as never);
    res.writeHead(r.statusCode ?? 204).end();
    return;
  }
  // Emails "sent" in the preview, newest last.
  if (url.pathname === "/outbox") {
    const { memoryOutbox } = await import("../src/lib/mail/outbox.js");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(memoryOutbox));
    return;
  }
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ env: "preview", apiUrl: "http://127.0.0.1:4300/api", userPoolId: "us-east-1_preview", userPoolClientId: "previewclient", region: "us-east-1" }));
    return;
  }
  const file = join(DIST, url.pathname);
  const path = existsSync(file) && extname(file) ? file : join(DIST, "index.html");
  const headers: Record<string, string> = { "content-type": TYPES[extname(path)] ?? "application/octet-stream" };
  if (CSP && path.endsWith(".html")) Object.assign(headers, { "content-security-policy": CSP });
  res.writeHead(200, headers).end(readFileSync(path));
}).listen(4300, "127.0.0.1", () => console.log("preview on http://127.0.0.1:4300"));
