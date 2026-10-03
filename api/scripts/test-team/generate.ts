/**
 * Builds a test team with made-up people, shaped like a real team, for feature and functionality testing.
 *
 * It takes the real team's non-personal structure from a hub export (tournament schedule, venues, practice
 * times, handbook, agenda, checklists) and invents everything about people: players, parents, phones,
 * emails, allergies, sizes, travel, coach and staff names. Names that appear in the export's shared text are
 * replaced, and the result is checked so no real player, parent or staff name is left anywhere.
 *
 * On top of that structure it adds data for every feature: availability answers, travel plans, uniform
 * sizes, ref jobs, claimed meals, a cancelled practice, a repeating event series (with a cancelled date),
 * one-off events that form a pattern (to try "Combine into series"), a team fund ledger, and pending payments.
 *
 * Like convert.ts it replays everything through the real API against a scratch DynamoDB, then writes the
 * team's items to one file for scripts/load-team.py.
 *
 *   DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npx vite-node scripts/test-team/generate.ts -- <exportDir> <out.json> [teamId] [clubId] [sourceTeamId]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [exportDir, outFile, teamId = "a5-13test", clubId = "a5", sourceTeam = "a5-13tom"] = process.argv.slice(2).filter((a) => a !== "--");
if (!exportDir || !outFile) {
  console.error("usage: generate.ts <exportDir> <out.json> [teamId] [clubId] [sourceTeamId]");
  process.exit(1);
}
process.env.TABLE_NAME = "TestTeam-scratch";
process.env.CLUB_ID = clubId;
process.env.AWS_REGION ??= "us-east-1";
process.env.DYNAMODB_ENDPOINT ??= "http://127.0.0.1:8000";

const { freshTable, event } = await import("../../test/api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { PutCommand, ScanCommand } = await import("@aws-sdk/lib-dynamodb");

type Doc = Record<string, any>;
const ADMIN = "test-generator";
const readJson = (p: string): Doc => JSON.parse(readFileSync(p, "utf8"));
const src = (col: string): [string, Doc][] => {
  const dir = join(exportDir, "teams", sourceTeam, col);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => [f.slice(0, -5), readJson(join(dir, f))]);
};
const compact = <T extends Doc>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null)) as T;

// ---------- a small seeded random, so every run makes the same team ----------
let seed = 20261003;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s: string, n: number) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const today = iso(new Date());

// ---------- made-up people ----------
const FIRST = ["Ava", "Mia", "Lily", "Zoe", "Nora", "Ella", "Ruby", "Ivy", "Maya", "Leah", "Sara", "Tessa", "Quinn"];
const LAST = ["Carter", "Brooks", "Hayes", "Morgan", "Reyes", "Bennett", "Foster", "Patel", "Nguyen", "Kim", "Ortiz", "Walsh", "Greene"];
const ADULT_F = ["Jen", "Amy", "Kara", "Beth", "Lisa", "Nina", "Tara", "Erin", "Gina", "Holly", "Dana", "Megan", "Paige"];
const ADULT_M = ["Mark", "Chris", "Dave", "Ben", "Matt", "Ryan", "Josh", "Eric", "Greg", "Adam", "Luke", "Sean", "Tony"];
const TOWNS = ["Duluth, GA", "Norcross, GA", "Suwanee, GA", "Lawrenceville, GA", "Alpharetta, GA", "Johns Creek, GA", "Cumming, GA", "Buford, GA"];
const SHIRTS = ["Youth L", "Youth XL", "Adult S", "Adult M", "Adult L"];
const ALLERGIES = ["None", "None", "None", "None", "Peanuts", "Tree nuts", "Dairy", "Shellfish", "None"];
let phone = 100;
const tel = () => `555-01${String(phone++ % 100).padStart(2, "0")}`;

/** Real names in the export's shared text (handbook, tasks, agenda…) → made-up ones. */
const RENAME: [RegExp, string][] = [
  [/Coach Tom/g, "Coach Morgan"], [/Coach Kate/g, "Coach Riley"],
  [/Nikki Schreiber/g, "Dana Cole"], [/Kate Vaughn/g, "Pat Lane"], [/Krista Miller/g, "Jo Park"],
  [/Ashley Savage/g, "Casey Reed"], [/Sam Yeargin/g, "Test Admin"],
  [/\bRyker\b/g, "Ava"], [/\bHarper\b/g, "Mia"], [/\bTom\b/g, "Morgan"]
];
const scrub = <T>(v: T): T => {
  if (typeof v === "string") return RENAME.reduce((s, [re, to]) => s.replace(re, to), v) as T;
  if (Array.isArray(v)) return v.map(scrub) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) as T;
  return v;
};

// ---------- replay helpers ----------
const problems: string[] = [];
async function call(method: string, path: string, body?: unknown, as = ADMIN) {
  const r = await handler(event(method, path, as, body));
  if ((r.statusCode ?? 0) >= 300) problems.push(`${method} ${path} → ${r.statusCode} ${r.body}`);
  return r.body ? JSON.parse(r.body) : undefined;
}
const T = `/teams/${teamId}`;

await freshTable();
await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin(clubId, ADMIN), type: "ClubAdmin" } }));

// ---------- team and settings ----------
const s = scrub(src("meta").find(([id]) => id === "settings")?.[1] ?? {});
const season = String(s.season ?? "2026-27").replace(/–/g, "-");
await call("POST", "/teams", { clubId, teamId, name: "A5 13 Test", season, age: "13U", copy: [] });
const practices = (s.practices ?? []).map((p: Doc) => compact({ id: p.id, label: p.label, dow: p.dow, start: p.start, end: p.end, from: p.from, until: p.until, location: p.location, note: p.note }));
await call("PUT", `${T}/settings`, compact({
  teamName: "A5 13 Test", season, age: "13U",
  coaches: [{ name: "Coach Morgan", phone: tel() }, { name: "Coach Riley", phone: tel() }],
  teamCode: "TEST13CODE",
  dues: { amountCents: 40000, due: s.dues?.due ?? addDays(today, 30), label: "Initial team fund deposit" },
  budget: { costPerMealCents: 2000, mealsPerDay: 2, people: 15, families: 13 },
  practices, cancelled: [], checklist: s.checklist ?? [], uniformItems: s.uniformItems ?? []
}));
const hb = scrub(src("meta").find(([id]) => id === "handbook")?.[1]);
if (hb) await call("PUT", `${T}/handbook`, { sections: hb.sections.map((x: Doc) => ({ t: x.t, b: x.b })) });

// ---------- roster ----------
const pids = FIRST.map((_, i) => `p${String(i + 1).padStart(2, "0")}`);
const players = pids.map((pid, i) => {
  const last = LAST[i];
  const mom = ADULT_F[i], dad = ADULT_M[(i + 5) % ADULT_M.length];
  return {
    pid, first: FIRST[i], last, jersey: String([2, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 20, 22][i]),
    shirt: pick(SHIRTS), town: `${pick(TOWNS)} 30000`, allergies: pick(ALLERGIES), refTeam: i % 2 ? "B" : "A", order: i + 1,
    parents: [
      { name: `${mom} ${last}`, cell: tel(), email: `${mom.toLowerCase()}.${last.toLowerCase()}@example.com` },
      ...(i % 4 === 3 ? [] : [{ name: `${dad} ${last}`, cell: tel(), email: `${dad.toLowerCase()}.${last.toLowerCase()}@example.com` }])
    ]
  };
});
for (const { pid, ...p } of players) await call("PUT", `${T}/players/${pid}`, p);
const pname = (pid: string) => players.find((p) => p.pid === pid)!;

// ---------- schedule from the real team's structure ----------
const EVENT_FIELDS = ["title", "date", "endDate", "time", "location", "city", "division", "website", "travel", "cartPid", "ballsPid",
  "parking", "waves", "arrival", "start", "meet", "uniforms", "admissions", "scheduleLink", "ticketHelp", "foodPlan",
  "reservations", "notes", "hotel", "hotelLink", "hotelCode", "hotelBy", "checklist"];
const events: Doc[] = [];
for (const [eid, raw] of src("events")) {
  const e = scrub(raw);
  const kind = e.type ?? e.kind ?? "event";
  const body: Doc = { kind };
  for (const f of EVENT_FIELDS) if (e[f] !== undefined) body[f] = e[f];
  if (kind === "tournament") {
    body.teamCode = "TEST13CODE";
    if (body.travel) { body.hotel = "Team hotel (test)"; body.hotelCode = "TESTBLOCK"; body.hotelBy = addDays(body.date, -21); }
  } else delete body.travel;
  await call("PUT", `${T}/events/${eid}`, compact(body));
  events.push({ eid, ...body });
}
// A repeating series with one cancelled date, starting next week.
const wed = (() => { let d = addDays(today, 1); while (new Date(`${d}T12:00:00`).getDay() !== 3) d = addDays(d, 1); return d; })();
await call("PUT", `${T}/events/e-open-gym`, {
  kind: "event", title: "Open gym", date: wed, time: "6:00 PM – 7:30 PM", location: "Test Sportsplex, Court 4",
  notes: "Optional extra reps. Bring water.", repeat: { every: 1, days: [3], until: addDays(wed, 56), skipTournaments: true },
  cancelled: [addDays(wed, 14)]
});
// Four one-off Sunday sessions (one week skipped) that the schedule should offer to combine into a series.
const sun = (() => { let d = addDays(today, 1); while (new Date(`${d}T12:00:00`).getDay() !== 0) d = addDays(d, 1); return d; })();
for (const [i, w] of [0, 1, 3, 4].entries()) {
  await call("PUT", `${T}/events/e-cond-${i + 1}`, { kind: "event", title: "Conditioning", date: addDays(sun, w * 7), time: "4:00 PM", location: "Test Sportsplex" });
}
// A practice cancelled for weather.
const sat = practices.find((p: Doc) => p.dow === 6);
if (sat) {
  let d = addDays(today, 1);
  while (new Date(`${d}T12:00:00`).getDay() !== 6) d = addDays(d, 1);
  await call("PUT", `${T}/practices/cancelled/pr-${sat.id}-${addDays(d, 7)}`);
}

// ---------- tournament extras ----------
for (const [eid, a] of src("agenda")) {
  const x = scrub(a);
  await call("PUT", `${T}/events/${eid}/agenda`, compact({ note: x.note, days: x.days.map((d: Doc) => ({ label: d.label, items: d.items.map((i: Doc) => compact({ what: i.what, where: i.where, who: i.who })) })) }));
}
const upcoming = events.filter((e) => e.kind === "tournament" && e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
const firstT = upcoming[0];
const travelT = upcoming.find((e) => e.travel);
if (firstT) {
  const JOBS = ["Book", "Score", "Libero", "Lines", "Lines", "Off"];
  const assign = Object.fromEntries(pids.map((pid, i) => [pid, { s1: JOBS[i % 6], s2: JOBS[(i + 2) % 6], s3: JOBS[(i + 4) % 6] }]));
  await call("PUT", `${T}/events/${firstT.eid}/refjobs`, { assign });
}
let mealsMade = 0;
for (const [mid, m] of src("meals")) {
  await call("PUT", `${T}/events/${m.eventId}/meals/${mid}`, compact({ day: m.day, meal: m.meal, time: m.time, plan: m.plan, costCents: Math.round(Number(m.cost || 0) * 100), claimedBy: mealsMade % 2 ? pids[mealsMade] : null }));
  mealsMade++;
}
if (travelT && !mealsMade) {
  await call("PUT", `${T}/events/${travelT.eid}/meals/m-test-1`, { day: travelT.date, meal: "Team dinner", time: "6:30 PM", costCents: 32000, claimedBy: null });
}

// ---------- families: availability, travel, sizes ----------
const items = (await call("GET", T)) as Doc;
const next = (await import("../../../web/src/app/core/schedule.js")).buildItems(items.events, items.settings)
  .filter((i: Doc) => i.date >= today && i.date <= addDays(today, 28) && i.kind !== "deadline" && !i.cancelled);
const SIZES = ["YM", "YL", "AS", "AM", "AL"];
for (const [i, pid] of pids.entries()) {
  if (i === 12) continue; // one family that hasn't answered anything, for "needs a reply"
  const rsvp: Record<string, string> = {};
  for (const it of next) if (rand() < 0.85) rsvp[it.key] = rand() < 0.75 ? "yes" : rand() < 0.5 ? "maybe" : "no";
  const body: Doc = { rsvp, uniform: { sizes: Object.fromEntries((items.settings.uniformItems ?? []).slice(0, 6).map((u: string) => [u, pick(SIZES)])) } };
  if (travelT && i < 8) {
    const p = pname(pid);
    body.travel = { [travelT.eid]: compact({
      mode: i % 3 ? "Fly" : "Drive",
      flight: i % 3 ? `TS ${100 + i * 7} ATL→${String(travelT.city ?? "").slice(0, 3).toUpperCase() || "XYZ"}` : undefined,
      hotel: "Team hotel (test)", conf: `TEST-${1000 + i}`,
      arrive: `${travelT.date} afternoon`, depart: `${travelT.endDate ?? travelT.date} evening`,
      notes: i === 0 ? `${p.first} rides with the ${pname(pids[1]).last} family from the airport` : undefined
    }) };
  }
  await call("PUT", `${T}/family/${pid}`, body);
}

// ---------- team fund ----------
const dues = (pid: string, n: number, cents: number, date: string) =>
  call("PUT", `${T}/ledger/l-dues-${pid}`, { kind: "in", cat: "Dues", pid, amountCents: cents, date, desc: n === 1 ? "Team fund deposit" : "Team fund deposit (partial)" });
for (const [i, pid] of pids.slice(0, 7).entries()) await dues(pid, i === 6 ? 2 : 1, i === 6 ? 20000 : 40000, addDays(today, -20 + i));
await call("PUT", `${T}/ledger/l-meal-1`, { kind: "out", cat: "Team meals", payee: "Pizza place (test)", amountCents: 18650, date: addDays(today, -10), desc: "Team dinner after practice" });
await call("PUT", `${T}/ledger/l-coach-1`, { kind: "out", cat: "Coach care", payee: "Coffee shop (test)", amountCents: 4200, date: addDays(today, -6), desc: "Coach snacks and drinks" });
await call("PUT", `${T}/ledger/l-cart-1`, { kind: "out", cat: "Tournament costs", payee: "Airline (test)", amountCents: 7500, date: addDays(today, -3), desc: "Checked bag fee for the ball cart" });
// Pending payments need a parent membership in the scratch table (left out of the output file).
const parentSub = (pid: string) => `test-parent-${pid}`;
for (const pid of [pids[7], pids[8], pids[2]]) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member(teamId, parentSub(pid)), type: "Membership", status: "active", roles: ["parent"], pid } }));
}
await call("POST", `${T}/payments`, { kind: "in", cat: "Dues", pid: pids[7], amountCents: 40000, date: addDays(today, -1), desc: "Deposit by Venmo" }, parentSub(pids[7]));
await call("POST", `${T}/payments`, { kind: "in", cat: "Dues", pid: pids[8], amountCents: 20000, date: today, desc: "Half now, half next month" }, parentSub(pids[8]));
await call("POST", `${T}/payments`, { kind: "out", cat: "Reimbursement", amountCents: 3895, date: addDays(today, -2), desc: "Gatorade and snacks for the girls" }, parentSub(pids[2]));

// ---------- home and team info ----------
const now = new Date();
const ann = (aid: string, text: string, pinned: boolean) => call("PUT", `${T}/announcements/${aid}`, { text, pinned });
await ann("a-welcome", "Welcome to the test team! Everything here is made up for trying out features.", true);
await ann("a-dues", "Team fund: each family's $400 deposit is due soon. Record your payment on the Team Fund tab.", true);
await ann("a-weather", "Saturday practice next week is cancelled for gym maintenance.", false);
void now;
for (const [kid, k] of src("tasks")) {
  const x = scrub(k);
  await call("PUT", `${T}/tasks/${kid}`, compact({ title: x.title, desc: x.desc, owner: x.owner ? "Dana Cole" : undefined, status: x.status, order: x.order }));
}

// ---------- read back, check, write ----------
const all: Doc[] = [];
let start: Doc | undefined;
do {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: start }));
  all.push(...(res.Items ?? []));
  start = res.LastEvaluatedKey;
} while (start);
const out = all
  .filter((i) => (String(i.PK) === `TEAM#${teamId}` && !String(i.SK).startsWith("MEMBER#")) || (i.PK === `CLUB#${clubId}` && i.SK === `TEAM#${teamId}`))
  .sort((a, b) => `${a.PK}|${a.SK}`.localeCompare(`${b.PK}|${b.SK}`));

// No real person may survive: every name from the source roster and staff lists is checked.
const real = new Set<string>();
for (const [, p] of src("players")) {
  for (const n of [p.first, p.last, ...(p.parents ?? []).flatMap((x: Doc) => String(x.name ?? "").split(/\s+/))]) if (n && n.length > 2) real.add(n);
  for (const x of p.parents ?? []) { if (x.email) real.add(x.email); if (x.cell) real.add(x.cell); }
}
const rawSettings = src("meta").find(([id]) => id === "settings")?.[1] ?? {};
for (const k of ["admins", "coordinators", "food", "finance"]) for (const n of rawSettings[k] ?? []) for (const w of String(n).split(/\s+/)) if (w.length > 2) real.add(w);
for (const c of rawSettings.coaches ?? []) { if (c.phone) real.add(c.phone); }
real.add(String(rawSettings.teamCode ?? "")); real.delete("");
for (const ok of FIRST.concat(LAST, ADULT_F, ADULT_M)) real.delete(ok); // a made-up name may match a real one by chance
const text = JSON.stringify(out);
const leaks = [...real].filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
if (leaks.length) problems.push(`Real names or details still present: ${leaks.join(", ")}`);

writeFileSync(outFile, JSON.stringify({ teamId, clubId, source: "made-up test data", generatedAt: new Date().toISOString(), items: out }, null, 2));
const count: Record<string, number> = {};
for (const i of out) { const k = String(i.SK).split("#")[0] + (String(i.SK).split("#").length > 2 ? `#…#${String(i.SK).split("#")[2]}` : ""); count[k] = (count[k] ?? 0) + 1; }
console.log(JSON.stringify({ teamId, items: out.length, kinds: count, problems }, null, 2));
if (problems.length) process.exit(2);
