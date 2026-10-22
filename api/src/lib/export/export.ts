/**
 * Team and club export: what's saved, as rows for the Team setup and Club setup workbooks
 * (docs/templates). It's the importer's mirror image (lib/import), so an exported workbook uploads
 * again without changes: the round-trip tests in test/import/export.test.ts check exactly that.
 *
 * Rows are objects keyed by the template's column names (without the " *"); the site writes them
 * into the template file, so the dropdowns, notes and Read me tab stay.
 *
 * Not in the templates, so not exported: families' answers, travel plans, meal claims, ref jobs,
 * uniform sizes and the fund ledger.
 */
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { getClub } from "../clubs.js";
import { keys, normEmail } from "../keys.js";
import { isExpired } from "../invites.js";
import { queryAll } from "../../api/util.js";
import type { Cell } from "../import/parse.js";

export type Rows = Record<string, Cell>[];
export type ExportSheets = Record<string, Rows>;

type Item = Record<string, unknown>;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const KIND_LABEL: Record<string, string> = { tournament: "Tournament", event: "Event", deadline: "Deadline", practice: "Practice" };
const STAFF_ROLES: [string, string][] = [["admin", "Team admin"], ["coach", "Coach"], ["coordinator", "Coordinator"], ["food", "Food"], ["finance", "Finance"]];
const LIST_LABEL = { checklist: "Packing checklist", uniformItems: "Uniform items", practiceColors: "Practice uniform colors" } as const;

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const yn = (v: boolean) => (v ? "Y" : "N");
const dollars = (cents: unknown) => (typeof cents === "number" && cents > 0 ? cents / 100 : "");
const repeatLabel = (every: unknown) => (Number(every) > 1 ? `Every ${Number(every)} weeks` : "Weekly");
const fullName = (first: unknown, last: unknown) => [s(first).trim(), s(last).trim()].filter(Boolean).join(" ");

/** Everything one team's export needs, read once. */
async function loadTeam(teamId: string) {
  const items = await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${teamId}` } });
  const invites = (await queryAll({
    IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :t AND begins_with(GSI1SK, :i)",
    ExpressionAttributeValues: { ":t": `TEAM#${teamId}`, ":i": "INVITE#" }
  })).filter((i) => !isExpired(i));
  const members = items.filter((i) => String(i.SK).startsWith("MEMBER#") && i.status === "active").map((m) => ({ ...m, sub: String(m.SK).slice(7) }) as Item & { sub: string });
  // Names for members whose membership has none (accounts from before names were kept there).
  const nameless = members.filter((m) => !m.firstName).map((m) => keys.profile(m.sub));
  const profiles = new Map<string, Item>();
  for (let i = 0; i < nameless.length; i += 100) {
    const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: nameless.slice(i, i + 100) } } }));
    for (const p of res.Responses?.[TABLE] ?? []) profiles.set(String(p.PK).slice(5), p);
  }
  return { items, invites, members, profiles };
}

/** One team's rows, tab by tab. `prefix` adds the Team ID column (club workbook). */
async function teamRows(teamId: string, club: boolean) {
  const { items, invites, members, profiles } = await loadTeam(teamId);
  const bySk = new Map(items.map((i) => [String(i.SK), i]));
  const settings = (bySk.get("META#SETTINGS") ?? {}) as Item;
  const handbook = (bySk.get("META#HANDBOOK") ?? {}) as Item;
  const id: Record<string, Cell> = club ? { "Team ID": teamId } : {};
  const dues = (settings.dues ?? {}) as Item, budget = (settings.budget ?? {}) as Item;

  // ----- staff: members and pending invites with a staff role -----
  const coachPhone = new Map(((settings.coaches ?? []) as Item[]).filter((c) => c.phone).map((c) => [s(c.name).toLowerCase(), s(c.phone)]));
  const coachOrder = ((settings.coaches ?? []) as Item[]).map((c) => s(c.name).toLowerCase());
  type Person = { email: string; first: string; last: string; roles: Set<string> };
  const coachRank = (p: Person) => {
    if (!p.roles.has("coach")) return 1000;
    const i = coachOrder.indexOf(fullName(p.first, p.last).toLowerCase());
    return i < 0 ? 999 : i;
  };
  const people = new Map<string, Person>();
  const addPerson = (email: string, first: string, last: string, roles: string[]) => {
    if (!email) return;
    const p = people.get(email) ?? { email, first, last, roles: new Set<string>() };
    roles.forEach((r) => p.roles.add(r));
    people.set(email, p);
  };
  for (const m of members) {
    const prof = profiles.get(m.sub) ?? {};
    addPerson(normEmail(s(m.email)), s(m.firstName || prof.firstName), s(m.firstName ? m.lastName : prof.lastName), (m.roles ?? []) as string[]);
  }
  for (const i of invites) addPerson(normEmail(s(i.email)), s(i.firstName), s(i.lastName), (i.roles ?? []) as string[]);
  const staff: Rows = [...people.values()]
    .filter((p) => STAFF_ROLES.some(([r]) => p.roles.has(r)))
    // Coaches first, in the team's order (the importer lists coaches in row order), then everyone else by name.
    .sort((a, b) => coachRank(a) - coachRank(b) || fullName(a.first, a.last).localeCompare(fullName(b.first, b.last)) || a.email.localeCompare(b.email))
    .map((p) => {
      const phone = coachPhone.get(fullName(p.first, p.last).toLowerCase()) ?? "";
      return {
        ...id, "First name": p.first, "Last name": p.last, "Email": p.email, "Mobile": phone,
        ...Object.fromEntries(STAFF_ROLES.map(([r, col]) => [col, yn(p.roles.has(r))])),
        "Show phone to families": yn(!!phone)
      };
    });

  // ----- roster: players and their parents -----
  // A parent is invited (Y) if they're on the team as this player's parent, or an invite is waiting.
  const invited = new Set(invites.map((i) => normEmail(s(i.email))));
  const parentOf = new Set(members.filter((m) => ((m.roles ?? []) as string[]).includes("parent")).map((m) => `${normEmail(s(m.email))}|${s(m.pid)}`));
  const players = items.filter((i) => /^PLAYER#[^#]+$/.test(String(i.SK)))
    .map((p) => ({ ...p, pid: String(p.SK).slice(7) }) as Item & { pid: string })
    .sort((a, b) => Number(a.order ?? 999) - Number(b.order ?? 999) || s(a.first).localeCompare(s(b.first)));
  const jerseyOf = new Map(players.map((p) => [p.pid, s(p.jersey)]));
  const roster: Rows = players.map((p) => {
    const parents = (((bySk.get(`PLAYER#${p.pid}#CONTACTS`) ?? {}) as Item).parents ?? []) as Item[];
    const row: Record<string, Cell> = {
      ...id, "Jersey": s(p.jersey), "Player first name": s(p.first), "Player last name": s(p.last), "Shirt size": s(p.shirt),
      "Town": s(p.town), "Allergies": s(p.allergies), "Ref group": s(p.refTeam)
    };
    parents.slice(0, 4).forEach((par, k) => {
      const email = normEmail(s(par.email));
      row[`Parent ${k + 1} name`] = s(par.name);
      row[`Parent ${k + 1} email`] = email;
      row[`Parent ${k + 1} mobile`] = s(par.cell);
      row[`Parent ${k + 1} invite`] = email ? yn(invited.has(email) || parentOf.has(`${email}|${p.pid}`)) : "";
    });
    return row;
  });

  // ----- practices and schedule -----
  const events = items.filter((i) => /^EVENT#[^#]+$/.test(String(i.SK)))
    .sort((a, b) => s(a.date).localeCompare(s(b.date)) || s(a.title).localeCompare(s(b.title)));
  const isPattern = (e: Item) => {
    const rep = e.repeat as { days?: number[] } | undefined;
    return e.kind === "practice" && !e.endDate && rep?.days?.length === 1;
  };
  const practices: Rows = events.filter(isPattern).map((e) => {
    const rep = e.repeat as { every?: number; days: number[]; until?: string };
    return {
      ...(club ? { "Applies to": teamId } : {}),
      "Name": s(e.title), "Day": DAYS[rep.days[0]], "Start time": s(e.time), "End time": s(e.endTime), "First date": s(e.date),
      "Last date": s(rep.until), "Repeats": repeatLabel(rep.every), "Location": s(e.location), "Court": s(e.court),
      "Uniform color": s(e.uniformColor), "Note": s(e.notes), "Address": s(e.address)
    };
  });
  const family = (pid: unknown) => (pid === "na" ? "Not needed" : pid ? jerseyOf.get(s(pid)) ?? "" : "");
  const schedule: Rows = events.filter((e) => !isPattern(e)).map((e) => {
    const rep = e.repeat as { every?: number; days?: number[]; until?: string } | undefined;
    return {
      ...(club ? { "Teams": teamId } : {}),
      "Type": KIND_LABEL[s(e.kind)] ?? "Event", "Title": s(e.title), "Start date": s(e.date), "End date": s(e.endDate), "Time": s(e.time),
      "Venue": s(e.location), "City": s(e.city), "Division": s(e.division), "Travel": e.kind === "tournament" ? yn(!!e.travel) : "",
      "Website": s(e.website), "Admission link": s(e.admissions), "Hotel": s(e.hotel), "Hotel link": s(e.hotelLink),
      "Hotel block code": s(e.hotelCode), "Book hotel by": s(e.hotelBy),
      // The club workbook's Shared schedule has no family columns.
      ...(club ? {} : { "Ball cart family": family(e.cartPid), "Volleyballs family": family(e.ballsPid) }),
      "Repeats": rep ? repeatLabel(rep.every) : "None", "Repeat days": rep ? (rep.days ?? []).map((d) => DAYS[d].slice(0, 3)).join(", ") : "",
      "Repeat until": rep ? s(rep.until) : "", "Notes": s(e.notes),
      "Court": e.kind === "practice" ? s(e.court) : "", "Uniform color": e.kind === "practice" ? s(e.uniformColor) : "",
      "Address": s(e.address), "Hotel address": e.kind === "tournament" ? s(e.hotelAddress) : ""
    };
  });

  // ----- lists and handbook -----
  const itemCol = club ? "Text or item" : "Item";
  const listCol = "List";
  const lists: Rows = [];
  for (const [k, label] of Object.entries(LIST_LABEL)) {
    for (const v of ((settings[k] ?? []) as string[])) lists.push({ ...id, [listCol]: label, "Title": "", [itemCol]: v });
  }
  for (const sec of ((handbook.sections ?? []) as Item[])) lists.push({ ...id, [listCol]: "Handbook section", "Title": s(sec.t), [itemCol]: s(sec.b) });

  return {
    settings, staff, roster, practices, schedule, lists,
    team: {
      "Team name": s(settings.teamName), "Season": s(settings.season), "Age group": s(settings.age), "Level / division": s(settings.level),
      "Team code": s(settings.teamCode), "Dues amount": dollars(dues.amountCents), "Dues due date": s(dues.due), "Dues label": s(dues.label),
      "Meal cost per person": dollars(budget.costPerMealCents), "Meals per day": s(budget.mealsPerDay), "People fed": s(budget.people)
    } as Record<string, Cell>
  };
}

/** The Team setup workbook's tabs for one team. */
export async function exportTeam(teamId: string): Promise<{ name: string; sheets: ExportSheets }> {
  const t = await teamRows(teamId, false);
  return {
    name: s(t.settings.teamName) || teamId,
    sheets: { "Team": [t.team], "Staff": t.staff, "Roster": t.roster, "Practices": t.practices, "Schedule": t.schedule, "Lists": t.lists }
  };
}

/** The Club setup workbook's tabs: the club and every team in it that isn't archived. */
export async function exportClub(clubId: string): Promise<{ name: string; sheets: ExportSheets; teams: string[]; archived: string[] }> {
  const club = await getClub(clubId);
  const admins = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :a)", ExpressionAttributeValues: { ":p": `CLUB#${clubId}`, ":a": "ADMIN#" } });
  const adminInvites = (await queryAll({
    IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :c AND begins_with(GSI1SK, :i)",
    ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":i": "INVITE#" }
  })).filter((i) => !isExpired(i));
  const dir = await queryAll({ KeyConditionExpression: "PK = :c AND begins_with(SK, :t)", ExpressionAttributeValues: { ":c": `CLUB#${clubId}`, ":t": "TEAM#" } });
  const live = dir.filter((d) => !d.archived).sort((a, b) => s(a.SK).localeCompare(s(b.SK)));

  const sheets: ExportSheets = {
    "Club": [{ "Club name": s(club?.name), "Short name": s(club?.short), "Club ID": clubId, "Main color": s(club?.colors?.primary), "Accent color": s(club?.colors?.accent), "Notes for every team": s(club?.notes) }],
    "Club links": (club?.links ?? []).map((l) => ({ "Label": l.label, "Web address": l.url })),
    "Club admins": [
      ...admins.filter((a) => a.email).map((a) => ({ "First name": s(a.firstName), "Last name": s(a.lastName), "Email": normEmail(s(a.email)) })),
      ...adminInvites.map((i) => ({ "First name": s(i.firstName), "Last name": s(i.lastName), "Email": normEmail(s(i.email)) }))
    ],
    "Teams": [], "Staff": [], "Rosters": [], "Practice patterns": [], "Shared schedule": [], "Team lists": [], "Defaults": []
  };
  for (const d of live) {
    const teamId = String(d.SK).slice(5);
    const t = await teamRows(teamId, true);
    const dues = (t.settings.dues ?? {}) as Item;
    sheets["Teams"].push({
      "Team ID": teamId, "Team name": s(t.settings.teamName || d.name), "Program": s(d.program), "Age group": s(t.settings.age || d.age),
      "Level / division": s(t.settings.level || d.level), "Season": s(t.settings.season || d.season), "Team code": s(t.settings.teamCode),
      "Dues amount": dollars(dues.amountCents), "Dues due date": s(dues.due), "Copy setup from": ""
    });
    sheets["Staff"].push(...t.staff);
    sheets["Rosters"].push(...t.roster);
    sheets["Practice patterns"].push(...t.practices);
    sheets["Shared schedule"].push(...t.schedule);
    sheets["Team lists"].push(...t.lists);
  }
  return { name: s(club?.name) || clubId, sheets, teams: live.map((d) => String(d.SK).slice(5)), archived: dir.filter((d) => d.archived).map((d) => String(d.SK).slice(5)) };
}

/** Rows as a sheet the importer reads: a header row (the given columns, or every key used) and the values. */
export function toSheet(rows: Rows, columns?: string[]): Cell[][] {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols, ...rows.map((r) => cols.map((c) => r[c] ?? null))];
}
