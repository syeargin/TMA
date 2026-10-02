/**
 * Converts a claude.ai Team Hub export into Team Hub table items for one team.
 *
 * The export is the hub's database saved as JSON files (teams/<t>.json and teams/<t>/<collection>/<doc>.json).
 * Rather than build table items by hand, this replays every record through the real API against a scratch
 * DynamoDB (DynamoDB Local or moto), so the items get exactly the keys, indexes and validation the API uses.
 * It then reads the team's items back out and writes them to one JSON file for scripts/load-team.py.
 *
 *   DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npx vite-node scripts/hub-import/convert.ts -- <exportDir> <out.json> [teamId] [clubId]
 *
 * Nothing here talks to AWS. The scratch table is deleted and recreated each run.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [exportDir, outFile, teamId = "a5-13tom", clubId = "a5"] = process.argv.slice(2).filter((a) => a !== "--");
if (!exportDir || !outFile) {
  console.error("usage: convert.ts <exportDir> <out.json> [teamId] [clubId]");
  process.exit(1);
}
process.env.TABLE_NAME = "HubImport-scratch";
process.env.CLUB_ID = clubId;
process.env.AWS_REGION ??= "us-east-1";
process.env.DYNAMODB_ENDPOINT ??= "http://127.0.0.1:8000";

const { freshTable, event } = await import("../../test/api/harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { PutCommand, ScanCommand } = await import("@aws-sdk/lib-dynamodb");

type Doc = Record<string, any>;
const IMPORTER = "hub-import";
const readJson = (p: string): Doc => JSON.parse(readFileSync(p, "utf8"));
function readCol(col: string): [string, Doc][] {
  const dir = join(exportDir, "teams", teamId, col);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => [f.slice(0, -5), readJson(join(dir, f))]);
}
/** Drops empty strings and nulls so optional fields stay unset rather than blank. */
function compact<T extends Doc>(o: T): T {
  const out: Doc = {};
  for (const [k, v] of Object.entries(o)) if (v !== "" && v !== null && v !== undefined) out[k] = v;
  return out as T;
}
const cents = (dollars: unknown) => Math.round(Number(dollars || 0) * 100);

const problems: string[] = [];
const notes: string[] = [];
const counts: Record<string, number> = {};
async function call(method: string, path: string, body?: unknown) {
  const r = await handler(event(method, path, IMPORTER, body));
  const ok = (r.statusCode ?? 0) < 300;
  if (!ok) problems.push(`${method} ${path} → ${r.statusCode} ${r.body}`);
  else { const k = path.split("/").filter((s) => !s.startsWith("{"))[3] ?? path; counts[k] = (counts[k] ?? 0) + 1; }
  return ok;
}

await freshTable();
await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.clubAdmin(clubId, IMPORTER), type: "ClubAdmin" } }));

// ---------- team ----------
const teamFile = join(exportDir, "teams", `${teamId}.json`);
const team = existsSync(teamFile) ? readJson(teamFile) : {};
const metaSettings = readCol("meta").find(([id]) => id === "settings")?.[1] ?? {};
const handbook = readCol("meta").find(([id]) => id === "handbook")?.[1];
const season = String(metaSettings.season ?? team.season ?? "").replace(/–/g, "-"); // en dash → hyphen
await call("POST", "/teams", { clubId, teamId, name: metaSettings.teamName ?? team.name ?? teamId, season, age: team.age ?? "", copy: [] });

const s = metaSettings;
await call("PUT", `/teams/${teamId}/settings`, compact({
  teamName: s.teamName ?? team.name ?? teamId,
  season,
  age: team.age ?? s.age ?? "",
  coaches: (s.coaches ?? []).map((c: Doc) => compact({ name: c.name, phone: c.phone })),
  teamCode: s.teamCode,
  dues: compact({ amountCents: cents(s.dues?.amount), due: s.dues?.due, label: s.dues?.label }),
  budget: s.budget ? compact({ costPerMealCents: cents(s.budget.costPerMeal), mealsPerDay: s.budget.mealsPerDay, people: s.budget.people, families: s.budget.families }) : undefined,
  practices: (s.practices ?? []).map((p: Doc) => compact({ id: p.id, label: p.label, dow: p.dow, start: p.start, end: p.end, from: p.from, until: p.until, location: p.location, note: p.note })),
  cancelled: s.cancelled ?? [],
  checklist: s.checklist ?? [],
  uniformItems: s.uniformItems ?? []
}));
const roleLists = { admins: "Team admin", coordinators: "Team coordinator", food: "Food coordinator", finance: "Finance" } as const;
for (const [k, label] of Object.entries(roleLists)) {
  const names = (s[k] ?? []) as string[];
  if (names.length) notes.push(`${label}: ${names.join(", ")} (roles come from member accounts in Team Hub; invite them to give them the role)`);
}
if ((s.video ?? []).length) notes.push(`Settings had ${s.video.length} video link(s), which Team Hub doesn't have a place for yet.`);
if (handbook) await call("PUT", `/teams/${teamId}/handbook`, { sections: (handbook.sections ?? []).map((x: Doc) => ({ t: x.t ?? "", b: x.b ?? "" })) });

// ---------- roster ----------
for (const [pid, p] of readCol("players")) {
  await call("PUT", `/teams/${teamId}/players/${pid}`, compact({
    first: p.first, last: p.last, jersey: p.jersey != null ? String(p.jersey) : undefined, shirt: p.shirt, town: p.town,
    allergies: p.allergies, refTeam: p.refTeam === "A" || p.refTeam === "B" ? p.refTeam : undefined, order: p.order,
    parents: (p.parents ?? []).map((x: Doc) => compact({ name: x.name ?? "", cell: x.cell, email: x.email }))
  }));
}

// ---------- schedule ----------
const EVENT_FIELDS = ["title", "date", "endDate", "time", "location", "city", "division", "website", "travel", "cartPid", "ballsPid", "dutyPid",
  "parking", "waves", "arrival", "start", "meet", "uniforms", "admissions", "teamCode", "scheduleLink", "ticketHelp", "foodPlan",
  "reservations", "notes", "hotel", "hotelLink", "hotelCode", "hotelBy", "checklist"];
for (const [eid, e] of readCol("events")) {
  const kind = e.type ?? e.kind ?? "event";
  const body: Doc = { kind };
  for (const f of EVENT_FIELDS) if (e[f] !== undefined) body[f] = e[f];
  if (kind !== "tournament") delete body.travel;
  const extra = Object.keys(e).filter((k) => !EVENT_FIELDS.includes(k) && k !== "type" && k !== "kind" && e[k] !== "" && e[k] != null);
  if (extra.length) notes.push(`Event ${eid}: not carried over: ${extra.join(", ")}`);
  await call("PUT", `/teams/${teamId}/events/${eid}`, compact(body));
}
for (const [eid, a] of readCol("agenda")) {
  await call("PUT", `/teams/${teamId}/events/${eid}/agenda`, compact({
    note: a.note,
    days: (a.days ?? []).map((d: Doc) => ({ label: d.label ?? "", items: (d.items ?? []).map((i: Doc) => compact({ what: i.what ?? "", where: i.where, who: i.who })) }))
  }));
}
for (const [eid, r] of readCol("refjobs")) await call("PUT", `/teams/${teamId}/events/${eid}/refjobs`, { assign: r.assign ?? r });
for (const [mid, m] of readCol("meals")) {
  if (!m.eventId) { problems.push(`Meal ${mid} has no tournament`); continue; }
  await call("PUT", `/teams/${teamId}/events/${m.eventId}/meals/${mid}`, compact({
    day: m.day, meal: m.meal, time: m.time, plan: m.plan, costCents: cents(m.cost), claimedBy: m.claimedBy || null
  }));
}

// ---------- home and info ----------
const annMeta: Record<string, Doc> = {};
for (const [aid, a] of readCol("announcements")) {
  annMeta[aid] = a;
  await call("PUT", `/teams/${teamId}/announcements/${aid}`, { text: a.text ?? "", pinned: !!a.pinned });
}
for (const [kid, k] of readCol("tasks")) {
  await call("PUT", `/teams/${teamId}/tasks/${kid}`, compact({ title: k.title, desc: k.desc, owner: k.owner, status: k.status, order: k.order }));
}
for (const [lid, l] of readCol("ledger")) {
  await call("PUT", `/teams/${teamId}/ledger/${lid}`, compact({ kind: l.kind, cat: l.cat, pid: l.pid, payee: l.payee, amountCents: l.amountCents ?? cents(l.amount), date: l.date, desc: l.desc ?? "" }));
}

// ---------- read back ----------
const items: Doc[] = [];
let start: Doc | undefined;
do {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: start }));
  items.push(...(res.Items ?? []));
  start = res.LastEvaluatedKey;
} while (start);

const out = items
  // The team's own records and its club directory entry. Club records and the importer's admin record stay behind.
  .filter((i) => String(i.PK) === `TEAM#${teamId}` || (i.PK === `CLUB#${clubId}` && i.SK === `TEAM#${teamId}`))
  .map((i) => {
    const x = { ...i };
    for (const k of ["updatedBy", "createdBy"]) if (x[k] === IMPORTER) x[k] = "hub-import";
    // Announcements keep their original time and "from" line.
    if (String(x.SK).startsWith("ANN#")) {
      const a = annMeta[String(x.SK).slice(4)];
      if (a?.at) { x.at = /Z|[+-]\d\d:?\d\d$/.test(a.at) ? a.at : `${a.at}Z`; x.GSI2SK = `${x.at}#${String(x.SK).slice(4)}`; }
      x.by = "";
      if (a?.by) x.byName = a.by;
    }
    return x;
  })
  .sort((a, b) => `${a.PK}|${a.SK}`.localeCompare(`${b.PK}|${b.SK}`));

writeFileSync(outFile, JSON.stringify({ teamId, clubId, source: exportDir, convertedAt: new Date().toISOString(), items: out }, null, 2));
const bySk: Record<string, number> = {};
for (const i of out) { const k = String(i.SK).replace(/#[^#]+$/, "#…").replace(/^EVENT#[^#]+/, "EVENT#…"); bySk[k] = (bySk[k] ?? 0) + 1; }
console.log(JSON.stringify({ items: out.length, kinds: bySk, calls: counts, problems, notes }, null, 2));
if (problems.length) process.exit(2);
