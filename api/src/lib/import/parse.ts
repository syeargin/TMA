/**
 * Reads the Team setup and Club setup workbooks (docs/templates) into plans for the importer.
 *
 * The browser sends each sheet as rows of plain cell values (dates already turned into YYYY-MM-DD text,
 * times into "6:30 PM"). Everything here is pure: no database. Every problem names its tab and row
 * (row numbers as Excel shows them), so families' coordinators can fix the sheet and upload again.
 */
import type { Role } from "../../shared/permissions.js";

export type Cell = string | number | boolean | null;
export type Sheets = Record<string, Cell[][]>;
export type Problem = { sheet: string; row?: number; message: string; level: "error" | "warning" };

export type StaffPlan = { row: number; sheet: string; first: string; last: string; email: string; mobile?: string; roles: Role[]; showPhone: boolean };
export type ParentPlan = { name: string; email?: string; cell?: string; invite: boolean };
export type PlayerPlan = {
  row: number; sheet: string; jersey?: string; first: string; last: string; shirt?: string; town?: string; allergies?: string;
  refTeam?: "A" | "B"; parents: ParentPlan[]; order: number;
};
export type PracticePlan = {
  label: string; dow: number; start: string; end?: string; from: string; until?: string; location?: string; note?: string;
  /** 1 = weekly, 2 or 3 = every 2 or 3 weeks, 0 = one date only. */
  every: number; court?: string; uniformColor?: string;
};
export type EventPlan = {
  row: number; sheet: string; kind: "tournament" | "event" | "deadline" | "practice"; court?: string; uniformColor?: string; title: string; date: string; endDate?: string; time?: string;
  location?: string; city?: string; division?: string; travel?: boolean; website?: string; admissions?: string;
  hotel?: string; hotelLink?: string; hotelCode?: string; hotelBy?: string; notes?: string;
  /** Jersey numbers of the families bringing the ball cart and volleyballs, or "na" (not needed). */
  cartJersey?: string; ballsJersey?: string;
  repeat?: { every: number; days: number[]; until: string; skipTournaments: boolean };
};
export type TeamPlan = {
  teamId: string; row?: number;
  name?: string; season?: string; age?: string; level?: string; program?: string; teamCode?: string;
  dues: { amountCents?: number; due?: string; label?: string };
  budget: { costPerMealCents?: number; mealsPerDay?: number; people?: number };
  copyFrom?: string;
  staff: StaffPlan[]; players: PlayerPlan[];
  /** Undefined: the workbook has no practices for this team, so the saved ones stay. */
  practices?: PracticePlan[];
  events: EventPlan[];
  checklist?: string[]; uniformItems?: string[]; practiceColors?: string[];
};
export type ClubPlan = {
  clubId?: string; name?: string; short?: string; colors?: { primary?: string; accent?: string }; notes?: string;
  links?: { label: string; url: string }[];
  admins: { row: number; email: string; firstName: string; lastName: string }[];
  /** Starting handbook and lists for teams the import creates. */
  defaults: { handbook: { t: string; b: string }[]; checklist: string[]; uniformItems: string[]; practiceColors: string[] };
};
export type Parsed =
  | { kind: "team"; team: TeamPlan; problems: Problem[] }
  | { kind: "club"; club: ClubPlan; teams: TeamPlan[]; problems: Problem[] };

export const TEAM_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MAX_ROWS = 3000;

/** Row 2 of each tab is an example. It's skipped when it still matches the template (first three cells). */
const EXAMPLES: Record<string, string[]> = {
  "Team": ["A5 13 Tom", "2026-27", "13U"],
  "Staff": ["Morgan", "Lee", "morgan.lee@example.com"],
  "Staff (club)": ["a5-13-tom", "Morgan", "Lee"],
  "Roster": ["7", "Ava", "Carter"],
  "Rosters": ["a5-13-tom", "7", "Ava"],
  "Practices": ["Saturday practice", "Saturday", "7:30 AM"],
  "Practice patterns": ["13U National", "Saturday practice", "Saturday"],
  "Schedule": ["Tournament", "Winter Invitational Classic", "2026-12-12"],
  "Shared schedule": ["All National", "Tournament", "Winter Invitational Classic"],
  "Lists": ["Packing checklist", "Knee and elbow pads", ""],
  "Club": ["A5 Volleyball", "A5", "a5"],
  "Club links": ["Registration and player-parent contract", "https://a5volleyball.sprocketsports.com/", ""],
  "Club admins": ["Pat", "Rivera", "pat.rivera@example.com"],
  "Teams": ["a5-13-tom", "A5 13-2 Tom", "National"],
  "Defaults": ["Handbook section", "Attendance", "Practices are mandatory. Tell your coach by text if you'll miss one."]
};

const text = (v: Cell | undefined): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v).trim();
};

/** One tab: rows by header name, skipping blank rows and an untouched example row. */
class Tab {
  readonly cols = new Map<string, number>();
  constructor(readonly name: string, private readonly data: Cell[][], private readonly problems: Problem[], exampleKey = name) {
    (data[0] ?? []).forEach((h, i) => { const k = text(h).replace(/\s*\*\s*$/, "").toLowerCase(); if (k && !this.cols.has(k)) this.cols.set(k, i); });
    this.example = EXAMPLES[exampleKey];
  }
  private readonly example?: string[];
  get present() { return this.data.length > 0; }
  has(col: string) { return this.cols.has(col.toLowerCase()); }
  *rows(): Generator<Row> {
    for (let i = 1; i < Math.min(this.data.length, MAX_ROWS + 1); i++) {
      const cells = this.data[i] ?? [];
      if (!cells.some((c) => text(c) !== "")) continue;
      if (i === 1 && this.example && this.example.every((e, k) => text(cells[k]).slice(0, 10) === e.slice(0, 10))) continue;
      yield new Row(this, cells, i + 1, this.problems);
    }
    if (this.data.length > MAX_ROWS + 1) this.problems.push({ sheet: this.name, level: "error", message: `Has more than ${MAX_ROWS} rows. Split it into smaller uploads.` });
  }
  col(name: string) { return this.cols.get(name.toLowerCase()); }
}

class Row {
  constructor(readonly tab: Tab, private readonly cells: Cell[], readonly n: number, private readonly problems: Problem[]) {}
  raw(col: string): Cell { const i = this.tab.col(col); return i === undefined ? null : this.cells[i] ?? null; }
  str(col: string, max = 500): string {
    const v = text(this.raw(col));
    if (v.length > max) { this.warn(`${col} is longer than ${max} characters; it was cut short.`); return v.slice(0, max); }
    return v;
  }
  opt(col: string, max = 500) { return this.str(col, max) || undefined; }
  need(col: string, max = 500): string {
    const v = this.str(col, max);
    if (!v) this.err(`${col} is required.`);
    return v;
  }
  err(message: string) { this.problems.push({ sheet: this.tab.name, row: this.n, message, level: "error" }); }
  warn(message: string) { this.problems.push({ sheet: this.tab.name, row: this.n, message, level: "warning" }); }

  yes(col: string): boolean | undefined {
    const v = this.str(col).toLowerCase();
    if (!v) return undefined;
    if (["y", "yes", "true", "1", "x"].includes(v)) return true;
    if (["n", "no", "false", "0"].includes(v)) return false;
    this.warn(`${col} should be Y or N (it says "${this.str(col)}"); treated as N.`);
    return false;
  }
  date(col: string, required = false): string | undefined {
    const v = this.raw(col);
    const out = toDate(v);
    if (out === null) { this.err(`${col} isn't a date (it says "${text(v)}"). Use a date like 2026-12-12.`); return undefined; }
    if (!out && required) this.err(`${col} is required.`);
    return out || undefined;
  }
  money(col: string): number | undefined {
    const v = this.raw(col);
    if (text(v) === "") return undefined;
    const n = typeof v === "number" ? v : Number(text(v).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 100_000) { this.err(`${col} should be an amount in dollars, like 400.`); return undefined; }
    return Math.round(n * 100);
  }
  int(col: string, max = 999): number | undefined {
    const v = text(this.raw(col));
    if (!v) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) { this.err(`${col} should be a whole number.`); return undefined; }
    return n;
  }
  email(col: string, required = false): string | undefined {
    const v = this.str(col, 200).toLowerCase();
    if (!v) { if (required) this.err(`${col} is required.`); return undefined; }
    if (!EMAIL.test(v)) { this.err(`${col} isn't an email address ("${v}").`); return undefined; }
    return v;
  }
  time(col: string): string | undefined {
    const v = this.raw(col);
    if (typeof v === "number" && v >= 0 && v < 1) return excelTime(v);
    return this.opt(col, 40);
  }
  day(col: string): number | undefined {
    const v = this.str(col).toLowerCase();
    if (!v) return undefined;
    const i = DAYS.findIndex((d) => d === v || d.slice(0, 3) === v.slice(0, 3));
    if (i < 0) { this.err(`${col} should be a day of the week, like Saturday.`); return undefined; }
    return i;
  }
  url(col: string): string | undefined {
    const v = this.opt(col, 500);
    if (v && !/^https?:\/\/\S+$/i.test(v)) { this.warn(`${col} should start with https:// ("${v}"); it was left out.`); return undefined; }
    return v;
  }
}

/** "" for blank, null when it isn't a date. Accepts YYYY-MM-DD, M/D/YYYY and Excel serial numbers. */
export function toDate(v: Cell | undefined): string | "" | null {
  if (v === null || v === undefined || text(v) === "") return "";
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = text(v);
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) [m, d, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3]) < 100 ? 2000 + Number(mt[3]) : Number(mt[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || y < 2000 || y > 2100) return null;
  return dt.toISOString().slice(0, 10);
}

export function excelTime(fraction: number): string {
  const mins = Math.round(fraction * 24 * 60) % (24 * 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ---------------------------------------------------------------- shared tabs

function staffRows(tab: Tab): StaffPlan[] {
  const out: StaffPlan[] = [];
  for (const r of tab.rows()) {
    const roles: Role[] = [];
    if (r.yes("Team admin")) roles.push("admin");
    if (r.yes("Coach")) roles.push("coach");
    if (r.yes("Coordinator")) roles.push("coordinator");
    if (r.yes("Food")) roles.push("food");
    if (r.yes("Finance")) roles.push("finance");
    const email = r.email("Email", true);
    const first = r.need("First name", 60), last = r.need("Last name", 60);
    if (!roles.length) r.warn("No role is marked Y, so they're invited as a coach.");
    if (!email || !first) continue;
    out.push({ row: r.n, sheet: tab.name, first, last, email, mobile: r.opt("Mobile", 40), roles: roles.length ? roles : ["coach"], showPhone: !!r.yes("Show phone to families") });
  }
  return out;
}

function rosterRow(r: Row, order: number): PlayerPlan | null {
  const first = r.need("Player first name", 60), last = r.need("Player last name", 60);
  const parents: ParentPlan[] = [];
  for (const n of [1, 2, 3, 4]) {
    const name = r.str(`Parent ${n} name`, 120);
    const email = r.email(`Parent ${n} email`, n === 1);
    if (!name && !email) { if (n === 1) r.err("Parent 1 name is required."); continue; }
    if (!name) r.err(`Parent ${n} name is required when there's an email.`);
    const invite = r.yes(`Parent ${n} invite`) ?? true;
    if (invite && !email) r.warn(`Parent ${n} has no email, so they can't be invited.`);
    parents.push({ name: name || email || "", email, cell: r.opt(`Parent ${n} mobile`, 40), invite: invite && !!email });
  }
  const ref = r.str("Ref group").toUpperCase();
  if (ref && ref !== "A" && ref !== "B") r.warn("Ref group should be A or B; it was left out.");
  if (!first) return null;
  return {
    row: r.n, sheet: r.tab.name, jersey: r.opt("Jersey", 10), first, last, shirt: r.opt("Shirt size", 20), town: r.opt("Town", 120),
    allergies: r.opt("Allergies", 200), refTeam: ref === "A" || ref === "B" ? ref : undefined, parents, order
  };
}

function practiceRow(r: Row): PracticePlan | null {
  const label = r.need("Name", 100);
  const dow = r.day("Day");
  if (r.str("Day") === "") r.err("Day is required.");
  const start = r.time("Start time");
  if (!start) r.err("Start time is required.");
  const from = r.date("First date", true);
  const until = r.date("Last date");
  if (from && until && until < from) r.err("Last date is before the first date.");
  const every = repeatEvery(r, "Repeats", 1);
  if (!label || dow === undefined || !start || !from || every === null) return null;
  return { label, dow, start, end: r.time("End time"), from, until, location: r.opt("Location", 200), note: r.opt("Note", 300),
    every, court: r.opt("Court", 40), uniformColor: r.opt("Uniform color", 40) };
}

/** "Weekly", "Every 2 weeks", "Every 3 weeks"; blank gives `blank`; "None" gives 0. Null (with an error) otherwise. */
function repeatEvery(r: Row, col: string, blank: number): number | null {
  const v = r.str(col).toLowerCase();
  if (!v) return blank;
  if (v === "none" || v === "no" || v === "does not repeat") return 0;
  if (v.startsWith("weekly") || v === "every week") return 1;
  const n = Number(/every (\d)/.exec(v)?.[1] ?? NaN);
  if (Number.isInteger(n) && n >= 1 && n <= 4) return n;
  r.err(`${col} should be None, Weekly, Every 2 weeks or Every 3 weeks (it says "${r.str(col)}").`);
  return null;
}

function eventRow(r: Row, withFamilies: boolean): EventPlan | null {
  const type = r.str("Type").toLowerCase();
  const kind = type.startsWith("tour") ? "tournament" : type.startsWith("dead") ? "deadline" : type.startsWith("prac") ? "practice"
    : type === "event" || type === "team event" ? "event" : null;
  if (!type) r.err("Type is required.");
  else if (!kind) r.err(`Type should be Practice, Tournament, Event or Deadline (it says "${r.str("Type")}").`);
  const title = r.need("Title", 160);
  const date = r.date("Start date", true);
  const endDate = r.date("End date");
  if (date && endDate && endDate < date) r.err("End date is before the start date.");
  let repeat: EventPlan["repeat"];
  const rep = r.str("Repeats").toLowerCase();
  if (rep && rep !== "none" && rep !== "no") {
    const every = rep.startsWith("weekly") || rep === "every week" ? 1 : Number(/every (\d)/.exec(rep)?.[1] ?? NaN);
    const until = r.date("Repeat until");
    if (kind === "tournament") r.err("Tournaments can't repeat. Set Repeats to None.");
    else if (!Number.isInteger(every) || every < 1 || every > 4) r.err("Repeats should be None, Weekly, Every 2 weeks or Every 3 weeks.");
    else if (!until) r.err("Repeat until is required for a repeating event.");
    else if (date && until < date) r.err("Repeat until is before the start date.");
    else {
      const named = r.str("Repeat days").split(/[\s,/&]+|\band\b/i).map((d) => d.trim().toLowerCase()).filter(Boolean);
      const days = named.map((d) => DAYS.findIndex((x) => x.slice(0, 3) === d.slice(0, 3)));
      if (days.some((d) => d < 0)) r.err(`Repeat days should be days of the week, like "Tue, Thu" (it says "${r.str("Repeat days")}").`);
      else if (date) repeat = { every, days: days.length ? [...new Set(days)].sort() : [new Date(date + "T12:00:00Z").getUTCDay()], until, skipTournaments: true };
    }
  }
  const family = (col: string) => {
    if (!withFamilies) return undefined;
    const v = r.str(col);
    if (!v) return undefined;
    return /^(not needed|n\/?a|none)$/i.test(v) ? "na" : v.replace(/^#/, "");
  };
  if (!kind || !title || !date) return null;
  return {
    row: r.n, sheet: r.tab.name, kind, title, date, endDate, time: r.time("Time"), location: r.opt("Venue", 200), city: r.opt("City", 120),
    division: r.opt("Division", 60), travel: kind === "tournament" ? r.yes("Travel") : undefined, website: r.url("Website"),
    admissions: r.url("Admission link"), hotel: r.opt("Hotel", 200), hotelLink: r.url("Hotel link"), hotelCode: r.opt("Hotel block code", 100),
    hotelBy: r.date("Book hotel by"), notes: r.opt("Notes", 2000),
    court: kind === "practice" ? r.opt("Court", 40) : undefined, uniformColor: kind === "practice" ? r.opt("Uniform color", 40) : undefined, cartJersey: family("Ball cart family"), ballsJersey: family("Volleyballs family"), repeat
  };
}

const emptyTeam = (teamId: string): TeamPlan => ({ teamId, dues: {}, budget: {}, staff: [], players: [], events: [] });

/** Settings columns shared by the Team tab (team workbook) and the Teams tab (club workbook). */
function teamColumns(r: Row, t: TeamPlan) {
  t.name = r.need("Team name", 100) || undefined;
  t.season = r.need("Season", 20) || undefined;
  t.age = r.need("Age group", 20) || undefined;
  t.level = r.opt("Level / division", 40);
  t.teamCode = r.opt("Team code", 40);
  t.dues = { amountCents: r.money("Dues amount"), due: r.date("Dues due date"), label: r.opt("Dues label", 100) };
  t.budget = { costPerMealCents: r.money("Meal cost per person"), mealsPerDay: r.int("Meals per day", 10), people: r.int("People fed", 99) };
}

function listsTab(tab: Tab, kindCol: string, itemCol: string, kinds: Record<string, "checklist" | "uniformItems" | "practiceColors" | "handbook">, titleCol?: string) {
  const out = { checklist: [] as string[], uniformItems: [] as string[], practiceColors: [] as string[], handbook: [] as { t: string; b: string }[] };
  for (const r of tab.rows()) {
    const k = r.str(kindCol).toLowerCase();
    const which = kinds[k];
    if (!which) { r.err(`${kindCol} should be one of: ${Object.keys(kinds).map((x) => x.replace(/\b\w/g, (c) => c.toUpperCase())).join(", ")}.`); continue; }
    const item = r.need(itemCol, which === "handbook" ? 10_000 : which === "practiceColors" ? 40 : 200);
    if (!item) continue;
    if (which === "handbook") out.handbook.push({ t: (titleCol && r.str(titleCol, 200)) || "", b: item });
    else out[which].push(item);
  }
  return out;
}

// ---------------------------------------------------------------- workbooks

export function workbookKind(sheets: Sheets): "team" | "club" | null {
  const names = new Set(Object.keys(sheets).map((n) => n.toLowerCase()));
  if (names.has("teams") && (names.has("club") || names.has("rosters"))) return "club";
  if (names.has("team") && names.has("roster")) return "team";
  return null;
}

function tab(sheets: Sheets, name: string, problems: Problem[], exampleKey?: string): Tab {
  const key = Object.keys(sheets).find((k) => k.toLowerCase() === name.toLowerCase());
  return new Tab(name, key ? sheets[key] : [], problems, exampleKey);
}

/** The Team setup workbook, for one team (its id comes from where it's uploaded). */
export function parseTeamWorkbook(sheets: Sheets, teamId: string): Parsed {
  const problems: Problem[] = [];
  const t = emptyTeam(teamId);
  const teamTab = tab(sheets, "Team", problems);
  let seen = 0;
  for (const r of teamTab.rows()) {
    if (seen++) { r.warn("Only the first team row is used."); continue; }
    t.row = r.n;
    teamColumns(r, t);
  }
  t.staff = staffRows(tab(sheets, "Staff", problems));
  let order = 0;
  for (const r of tab(sheets, "Roster", problems).rows()) { const p = rosterRow(r, order++); if (p) t.players.push(p); }
  const pr = tab(sheets, "Practices", problems);
  const practices: PracticePlan[] = [];
  for (const r of pr.rows()) { const p = practiceRow(r); if (p) practices.push(p); }
  if (practices.length) t.practices = practices;
  for (const r of tab(sheets, "Schedule", problems).rows()) { const e = eventRow(r, true); if (e) t.events.push(e); }
  const lists = listsTab(tab(sheets, "Lists", problems), "List", "Item", { "packing checklist": "checklist", "uniform items": "uniformItems", "practice uniform colors": "practiceColors" });
  if (lists.checklist.length) t.checklist = lists.checklist;
  if (lists.uniformItems.length) t.uniformItems = lists.uniformItems;
  if (lists.practiceColors.length) t.practiceColors = [...new Set(lists.practiceColors)].slice(0, 20);
  checkTeam(t, problems);
  return { kind: "team", team: t, problems };
}

/** The Club setup workbook: the club's settings and every team in it. */
export function parseClubWorkbook(sheets: Sheets, clubId: string): Parsed {
  const problems: Problem[] = [];
  const club: ClubPlan = { admins: [], defaults: { handbook: [], checklist: [], uniformItems: [], practiceColors: [] } };

  let seen = 0;
  for (const r of tab(sheets, "Club", problems).rows()) {
    if (seen++) { r.warn("Only the first club row is used."); continue; }
    club.name = r.need("Club name", 80) || undefined;
    club.short = r.opt("Short name", 12);
    club.clubId = r.str("Club ID").toLowerCase() || undefined;
    if (club.clubId && club.clubId !== clubId) r.err(`Club ID is "${club.clubId}", but you're uploading to the club "${clubId}". Fix the Club ID or upload it on that club's page.`);
    const hex = (col: string) => {
      const v = r.str(col);
      if (!v) return undefined;
      const h = (v.startsWith("#") ? v : "#" + v).toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(h)) { r.err(`${col} should be a color like #15294D.`); return undefined; }
      return h;
    };
    club.colors = { primary: hex("Main color"), accent: hex("Accent color") };
    club.notes = r.opt("Notes for every team", 4000);
  }
  const links: { label: string; url: string }[] = [];
  for (const r of tab(sheets, "Club links", problems).rows()) {
    const label = r.need("Label", 80), url = r.need("Web address", 500);
    if (url && !/^https?:\/\/\S+$/i.test(url)) { r.err("Web address must start with https://"); continue; }
    if (label && url) links.push({ label, url });
  }
  if (links.length > 12) problems.push({ sheet: "Club links", level: "error", message: "A club can have up to 12 links." });
  if (links.length) club.links = links.slice(0, 12);
  for (const r of tab(sheets, "Club admins", problems).rows()) {
    const email = r.email("Email", true);
    const firstName = r.need("First name", 60), lastName = r.str("Last name", 60);
    if (email) club.admins.push({ row: r.n, email, firstName, lastName });
  }

  // Teams, in sheet order.
  const teams = new Map<string, TeamPlan>();
  for (const r of tab(sheets, "Teams", problems).rows()) {
    const id = r.str("Team ID").toLowerCase();
    if (!id) { r.err("Team ID is required."); continue; }
    if (!TEAM_ID.test(id)) { r.err(`Team ID "${id}" can only have lowercase letters, numbers and dashes (2 to 40 characters).`); continue; }
    if (teams.has(id)) { r.err(`Team ID "${id}" is listed twice.`); continue; }
    const t = emptyTeam(id);
    t.row = r.n;
    teamColumns(r, t);
    const program = r.str("Program");
    if (!program) r.err("Program is required.");
    t.program = program ? program[0].toUpperCase() + program.slice(1).toLowerCase() : undefined;
    const copy = r.str("Copy setup from").toLowerCase();
    if (copy) t.copyFrom = copy;
    teams.set(id, t);
  }
  if (!teams.size) problems.push({ sheet: "Teams", level: "error", message: "List at least one team on the Teams tab." });
  const teamOf = (r: Row, col = "Team ID"): TeamPlan | undefined => {
    const id = r.str(col).toLowerCase();
    if (!id) { r.err(`${col} is required.`); return undefined; }
    const t = teams.get(id);
    if (!t) r.err(`Team ID "${id}" isn't on the Teams tab.`);
    return t;
  };

  const staffTab = tab(sheets, "Staff", problems, "Staff (club)");
  for (const r of staffTab.rows()) {
    const t = teamOf(r);
    // Parse the row with the shared staff reader by giving it a one-row view.
    if (!t) continue;
    const one = staffRows(new SingleRowTab(staffTab, r));
    t.staff.push(...one);
  }
  const orders = new Map<string, number>();
  for (const r of tab(sheets, "Rosters", problems).rows()) {
    const t = teamOf(r);
    if (!t) continue;
    const n = orders.get(t.teamId) ?? 0;
    orders.set(t.teamId, n + 1);
    const p = rosterRow(r, n);
    if (p) t.players.push(p);
  }
  const all = [...teams.values()];
  for (const r of tab(sheets, "Practice patterns", problems).rows()) {
    const targets = resolveGroup(r, "Applies to", all);
    const p = practiceRow(r);
    if (p) for (const t of targets) (t.practices ??= []).push({ ...p });
  }
  for (const r of tab(sheets, "Shared schedule", problems).rows()) {
    const targets = resolveGroup(r, "Teams", all);
    const e = eventRow(r, false);
    if (e) for (const t of targets) t.events.push({ ...e });
  }
  const d = listsTab(tab(sheets, "Defaults", problems), "Kind", "Text or item",
    { "handbook section": "handbook", "packing checklist": "checklist", "uniform items": "uniformItems", "practice uniform colors": "practiceColors" }, "Title");
  club.defaults = d;

  for (const t of all) {
    if (t.copyFrom && t.copyFrom === t.teamId) { problems.push({ sheet: "Teams", row: t.row, level: "error", message: "Copy setup from can't be the team itself." }); t.copyFrom = undefined; }
    checkTeam(t, problems);
  }
  return { kind: "club", club, teams: all, problems };
}

/** A Tab whose only row is one already-read row (lets the club Staff tab reuse the team staff reader). */
class SingleRowTab extends Tab {
  constructor(private readonly parent: Tab, private readonly only: Row) { super(parent.name, [], []); }
  override has(col: string) { return this.parent.has(col); }
  override col(name: string) { return this.parent.col(name); }
  override *rows(): Generator<Row> { yield this.only; }
}

/** "13U National", "All Regional", "All", "a5-13-tom, a5-14-tom". */
function resolveGroup(r: Row, col: string, teams: TeamPlan[]): TeamPlan[] {
  const v = r.str(col);
  if (!v) { r.err(`${col} is required.`); return []; }
  const out = new Set<TeamPlan>();
  for (const part of v.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const byId = teams.find((t) => t.teamId === part.toLowerCase());
    if (byId) { out.add(byId); continue; }
    const words = part.toLowerCase().split(/\s+/).filter((w) => w !== "all" && w !== "teams");
    const age = words.find((w) => /^\d{1,2}u$/.test(w));
    const program = words.find((w) => !/^\d{1,2}u$/.test(w));
    if (words.length > 2 || (program && !["national", "regional", "boys"].includes(program))) {
      r.err(`${col}: "${part}" isn't a Team ID on the Teams tab or a group like "13U National", "All Regional" or "All".`);
      continue;
    }
    const match = teams.filter((t) => (!age || (t.age ?? "").toLowerCase() === age) && (!program || (t.program ?? "").toLowerCase() === program));
    if (!match.length) r.warn(`${col}: no team on the Teams tab is in "${part}".`);
    match.forEach((t) => out.add(t));
  }
  return [...out];
}

/** Checks within one team: duplicate players, jerseys and emails used for two people, practice and event limits. */
function checkTeam(t: TeamPlan, problems: Problem[]) {
  const where = (p: { sheet: string; row: number }) => ({ sheet: p.sheet, row: p.row });
  const jerseys = new Map<string, PlayerPlan>();
  const names = new Map<string, PlayerPlan>();
  for (const p of t.players) {
    if (p.jersey) {
      const other = jerseys.get(p.jersey);
      if (other) problems.push({ ...where(p), level: "error", message: `Jersey ${p.jersey} is also on row ${other.row}${t.teamId ? ` (${t.teamId})` : ""}.` });
      jerseys.set(p.jersey, p);
    }
    const nm = `${p.first} ${p.last}`.toLowerCase();
    const other = names.get(nm);
    if (other) problems.push({ ...where(p), level: "error", message: `${p.first} ${p.last} is also on row ${other.row}.` });
    names.set(nm, p);
  }
  if (t.players.length > 40) problems.push({ sheet: t.players[0].sheet, level: "error", message: `${t.teamId}: a team can have up to 40 players.` });
  if ((t.practices?.length ?? 0) > 20) problems.push({ sheet: "Practices", level: "error", message: `${t.teamId}: a team can have up to 20 weekly practices.` });
  const coaches = t.staff.filter((s) => s.roles.includes("coach"));
  if (coaches.length > 6) problems.push({ sheet: coaches[6].sheet, row: coaches[6].row, level: "warning", message: `${t.teamId}: only the first 6 coaches are shown on Team Info.` });
  const seen = new Map<string, StaffPlan>();
  for (const s of t.staff) {
    const o = seen.get(s.email);
    if (o) problems.push({ ...where(s), level: "warning", message: `${s.email} is also on row ${o.row}; their roles are combined.` });
    seen.set(s.email, s);
  }
  // Ball cart and volleyball families refer to jerseys on this team.
  for (const e of t.events) {
    for (const [col, j] of [["Ball cart family", e.cartJersey], ["Volleyballs family", e.ballsJersey]] as const) {
      if (j && j !== "na" && !jerseys.has(j)) problems.push({ ...where(e), level: "warning", message: `${col}: no player on the roster wears #${j}; it was left blank.` });
    }
  }
  const evKeys = new Map<string, EventPlan>();
  for (const e of t.events) {
    const k = eventKey(e);
    const o = evKeys.get(k);
    if (o) problems.push({ ...where(e), level: "warning", message: `${e.title} on ${e.date} is listed twice${o.sheet !== e.sheet || o.row !== e.row ? ` (also row ${o.row})` : ""}; the later row wins.` });
    evKeys.set(k, e);
  }
}

export const eventKey = (e: { kind?: unknown; title?: unknown; date?: unknown }) => `${e.kind}|${String(e.date)}|${String(e.title).trim().toLowerCase()}`;
export const playerName = (p: { first?: unknown; last?: unknown }) => `${String(p.first ?? "").trim()} ${String(p.last ?? "").trim()}`.toLowerCase();
