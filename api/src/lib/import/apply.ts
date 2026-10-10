/**
 * Compares an import plan with what's saved and (unless it's a preview) writes the difference.
 *
 * Uploading again updates instead of duplicating: teams match on team id, players on jersey and then
 * name, events on type + date + title, people on email. Nothing is ever removed, and fields families or
 * coaches filled in that the workbook doesn't have (answers, travel, meals, game-day details) are kept.
 */
import { BatchWriteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { DEFAULT_CLUB } from "../clubs.js";
import { keys, normEmail } from "../keys.js";
import { getItem, newId, now, queryAll } from "../../api/util.js";
import type { Role } from "../../shared/permissions.js";
import { convertPractices, firstOnOrAfter, practiceEvent, seasonEnd } from "../practices.js";
import { eventKey, playerName, type ClubPlan, type Problem, type TeamPlan } from "./parse.js";

export const DEFAULT_CHECKLIST = ["Court shoes", "Extra pair of socks", "Knee and elbow pads", "2 pairs of spandex", "Both jerseys", "Warmups", "Hair ties, ribbons, brush", "Volleyball backpack", "Water bottle", "Snacks", "Lunch"];
const INVITE_DAYS = 60;

type Item = Record<string, unknown>;
export type TeamSummary = {
  teamId: string; name: string; status: "new" | "update";
  players: { add: number; update: number; kept: number };
  events: { add: number; update: number };
  practices: number | null;
  invites: { staff: number; parents: number; alreadyOnTeam: number };
  lists: string[];
  copiedFrom?: string;
};

/** Removes undefined values (DynamoDB rejects them) and empty strings for optional fields. */
function defined<T extends Item>(o: T): T {
  const out: Item = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") out[k] = v;
  return out as T;
}

export async function putMany(items: Item[]) {
  for (let i = 0; i < items.length; i += 25) {
    let batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; batch.length; attempt++) {
      if (attempt > 6) throw new Error("The database is busy. Try the import again.");
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: batch } }));
      batch = (res.UnprocessedItems?.[TABLE] ?? []) as typeof batch;
    }
  }
}

/** Which club a team id belongs to, if it exists anywhere. */
export async function teamOwner(teamId: string): Promise<{ clubId: string | null; archived: boolean }> {
  const [link, settings] = await Promise.all([getItem(keys.teamClub(teamId)), getItem(keys.settings(teamId))]);
  const clubId = link ? String(link.clubId) : settings ? DEFAULT_CLUB() : null;
  const dir = clubId ? await getItem(keys.teamDir(clubId, teamId)) : undefined;
  return { clubId, archived: !!dir?.archived };
}

/**
 * Plans (and, with write, saves) one team. Problems found against saved data (another club owns the id,
 * the team is archived) go into `problems`; nothing is written for a team with such a problem.
 */
export async function importTeam(opts: {
  clubId: string; plan: TeamPlan; by: string; write: boolean; problems: Problem[];
  defaults?: ClubPlan["defaults"]; teamsInFile?: Set<string>;
}): Promise<TeamSummary | null> {
  const { clubId, plan: t, by, write, problems } = opts;
  const at = now();
  const where = { sheet: t.row ? (opts.teamsInFile ? "Teams" : "Team") : "Team", row: t.row };
  const owner = await teamOwner(t.teamId);
  if (owner.clubId && owner.clubId !== clubId) {
    problems.push({ ...where, level: "error", message: `Team ID "${t.teamId}" is already used by another club. Team IDs are unique across all clubs; pick another.` });
    return null;
  }
  if (owner.archived) {
    problems.push({ ...where, level: "error", message: `${t.teamId} is archived. A site owner has to restore it before it can be updated.` });
    return null;
  }
  const isNew = !owner.clubId;
  if (isNew && !t.name) {
    problems.push({ ...where, level: "error", message: `${t.teamId} is a new team, so it needs its team name, season and age group on the Team tab.` });
    return null;
  }

  const loadTeam = () => queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${t.teamId}` } });
  let saved = isNew ? [] : await loadTeam();
  // Teams still on weekly practice times: convert them first (a preview pretends they were converted).
  const legacySettings = saved.find((i) => i.SK === "META#SETTINGS");
  const legacy = ((legacySettings?.practices ?? []) as Item[]).filter((p) => p && p.from && p.id);
  if (legacy.length) {
    if (write) { await convertPractices(t.teamId, by); saved = await loadTeam(); }
    else saved = [...saved, ...legacy.map((p) => practiceEvent(t.teamId, p as never, (legacySettings?.cancelled ?? []) as string[], by, at).item as Item)];
  }
  const bySk = new Map(saved.map((i) => [String(i.SK), i]));
  const puts: Item[] = [];

  // ---------- players ----------
  const savedPlayers = saved.filter((i) => /^PLAYER#[^#]+$/.test(String(i.SK)));
  const byJersey = new Map(savedPlayers.filter((p) => p.jersey).map((p) => [String(p.jersey), p]));
  const byName = new Map(savedPlayers.map((p) => [playerName(p), p]));
  const used = new Set<string>();
  const pidOfJersey = new Map<string, string>();
  for (const p of savedPlayers) if (p.jersey) pidOfJersey.set(String(p.jersey), String(p.SK).slice(7));
  const pidOfRow = new Map<number, string>();
  const players = { add: 0, update: 0, kept: 0 };
  for (const p of t.players) {
    let match = (p.jersey && byJersey.get(p.jersey)) || byName.get(playerName(p));
    if (match && used.has(String(match.SK))) match = undefined;
    const pid = match ? String(match.SK).slice(7) : newId("p");
    if (match) { used.add(String(match.SK)); players.update++; } else players.add++;
    pidOfRow.set(p.row, pid);
    if (p.jersey) pidOfJersey.set(p.jersey, pid);
    const { PK: _pk, SK: _sk, ...rest } = (match ?? {}) as Item;
    // Blank cells keep what's saved.
    puts.push({
      ...rest, ...keys.player(t.teamId, pid), type: "Player",
      ...defined({ first: p.first, last: p.last, jersey: p.jersey, shirt: p.shirt, town: p.town, allergies: p.allergies, refTeam: p.refTeam }),
      order: match?.order ?? p.order, updatedAt: at, updatedBy: by
    });
    puts.push({ ...keys.contacts(t.teamId, pid), type: "Contacts", parents: p.parents.map((x) => defined({ name: x.name, cell: x.cell, email: x.email })), updatedAt: at });
  }
  players.kept = savedPlayers.length - used.size;

  // ---------- settings ----------
  const savedSettings = bySk.get("META#SETTINGS");
  let base: Item = savedSettings ? { ...savedSettings } : {
    ...keys.settings(t.teamId), type: "Settings", teamName: t.name, season: "", age: "", coaches: [], teamCode: "",
    dues: { amountCents: 0, due: "", label: "Team fund deposit" }, budget: { costPerMealCents: 2000, mealsPerDay: 2, people: 15 },
    practices: [], cancelled: [], checklist: DEFAULT_CHECKLIST, uniformItems: [], practiceColors: []
  };
  let copiedPractices: Item[] = [];
  let handbook: Item | undefined;
  let copiedFrom: string | undefined;
  if (isNew) {
    const d = opts.defaults;
    if (d?.checklist.length) base.checklist = d.checklist;
    if (d?.uniformItems.length) base.uniformItems = d.uniformItems;
    if (d?.practiceColors.length) base.practiceColors = d.practiceColors;
    if (d?.handbook.length) handbook = { ...keys.handbook(t.teamId), type: "Handbook", sections: d.handbook, updatedAt: at };
    if (t.copyFrom) {
      const src = await getItem(keys.settings(t.copyFrom));
      const srcOwner = src ? await teamOwner(t.copyFrom) : null;
      if (src && srcOwner?.clubId === clubId) {
        const hb = await getItem(keys.handbook(t.copyFrom));
        if (hb) handbook = { ...keys.handbook(t.teamId), type: "Handbook", sections: hb.sections ?? [], updatedAt: at };
        base = { ...base, checklist: src.checklist ?? base.checklist, uniformItems: src.uniformItems ?? base.uniformItems, practiceColors: src.practiceColors ?? base.practiceColors };
        // Its practice series (not their cancelled or changed dates), unless the workbook has practices of its own.
        if (!t.practices) {
          const srcEvents = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :e)", ExpressionAttributeValues: { ":p": `TEAM#${t.copyFrom}`, ":e": "EVENT#" } });
          copiedPractices = srcEvents.filter((e) => e.kind === "practice" && String(e.SK).split("#").length === 2).map((e) => {
            const eid = newId("pr");
            const { PK: _p, SK: _s, cancelled: _c, skip: _k, overrides: _o, convertedFrom: _f, ...rest } = e;
            return { ...rest, ...keys.event(t.teamId, eid), GSI2PK: `TEAM#${t.teamId}#CAL`, GSI2SK: `${e.date}#${eid}`, updatedAt: at, updatedBy: by };
          });
        }
        copiedFrom = t.copyFrom;
      } else if (!opts.teamsInFile?.has(t.copyFrom)) {
        problems.push({ ...where, level: "error", message: `Copy setup from: there's no team "${t.copyFrom}" in this club.` });
        return null;
      } else if (write) {
        problems.push({ ...where, level: "warning", message: `Copy setup from: ${t.copyFrom} wasn't saved yet, so nothing was copied.` });
      } else copiedFrom = t.copyFrom;
    }
    handbook ??= { ...keys.handbook(t.teamId), type: "Handbook", sections: [], updatedAt: at };
  }
  const coaches = t.staff.filter((s) => s.roles.includes("coach")).slice(0, 6).map((s) => defined({ name: `${s.first} ${s.last}`.trim(), phone: s.showPhone ? s.mobile : undefined }));
  const savedDues = (base.dues ?? {}) as Item, savedBudget = (base.budget ?? {}) as Item;
  const lists: string[] = [];
  if (t.checklist) lists.push("packing checklist");
  if (t.uniformItems) lists.push("uniform items");
  if (t.practiceColors) lists.push("practice uniform colors");
  // Uniform colors used on practices join the team's list, so coaches can pick them later.
  const colors = [...((t.practiceColors ?? base.practiceColors ?? []) as string[])];
  for (const c of [...(t.practices ?? []).map((p) => p.uniformColor), ...t.events.map((e) => e.uniformColor)]) {
    if (c && !colors.some((x) => x.toLowerCase() === c.toLowerCase())) colors.push(c);
  }
  const settings = defined({
    ...base,
    teamName: t.name ?? base.teamName, season: t.season ?? base.season, age: t.age ?? base.age, level: t.level ?? base.level,
    teamCode: t.teamCode ?? base.teamCode,
    coaches: coaches.length ? coaches : base.coaches ?? [],
    dues: defined({ ...savedDues, ...defined(t.dues as Item) }),
    budget: defined({ ...savedBudget, ...defined(t.budget as Item) }),
    checklist: t.checklist ?? base.checklist, uniformItems: t.uniformItems ?? base.uniformItems,
    practiceColors: colors.slice(0, 20),
    updatedAt: at, updatedBy: by
  });

  // ---------- events ----------
  const savedEvents = saved.filter((i) => /^EVENT#[^#]+$/.test(String(i.SK)));
  const evByKey = new Map(savedEvents.map((e) => [eventKey(e), e]));
  const events = { add: 0, update: 0 };
  const planned = new Map<string, Item>();
  for (const e of t.events) {
    const k = eventKey(e);
    const match = planned.get(k) ?? evByKey.get(k);
    const eid = match ? String(match.SK).slice(6) : newId("e");
    if (!planned.has(k)) { if (evByKey.has(k)) events.update++; else events.add++; }
    const pidFor = (j?: string) => (j === "na" ? "na" : j ? pidOfJersey.get(j) : undefined);
    const { cartJersey, ballsJersey, row: _r, sheet: _s, ...fields } = e;
    const item: Item = defined({
      ...(match ?? {}), ...keys.event(t.teamId, eid), type: "Event", ...defined(fields as Item),
      travel: e.kind === "tournament" ? e.travel ?? match?.travel ?? false : false,
      cartPid: pidFor(cartJersey) ?? match?.cartPid, ballsPid: pidFor(ballsJersey) ?? match?.ballsPid,
      GSI2PK: `TEAM#${t.teamId}#CAL`, GSI2SK: `${e.date}#${eid}`, updatedAt: at, updatedBy: by
    });
    if (!e.repeat) delete item.repeat;
    planned.set(k, item);
  }

  // ---------- practices ----------
  // Each row is a practice series, matched to a saved one by name, so cancelled dates, single-date changes and answers stay.
  const savedPractices = savedEvents.filter((e) => e.kind === "practice");
  const usedPractice = new Set<string>();
  for (const p of t.practices ?? []) {
    const match = savedPractices.find((e) => !usedPractice.has(String(e.SK)) && String(e.title ?? "").toLowerCase() === p.label.toLowerCase());
    if (match) usedPractice.add(String(match.SK));
    const eid = match ? String(match.SK).slice(6) : newId("pr");
    const date = firstOnOrAfter(p.from, p.dow);
    const end = p.until || seasonEnd(p.from);
    const item: Item = {
      ...(match ?? {}), ...keys.event(t.teamId, eid), type: "Event",
      ...defined({ kind: "practice", title: p.label, date, time: p.start, endTime: p.end, location: p.location, court: p.court, uniformColor: p.uniformColor, notes: p.note }),
      travel: false, GSI2PK: `TEAM#${t.teamId}#CAL`, GSI2SK: `${date}#${eid}`, updatedAt: at, updatedBy: by
    };
    if (p.every) item.repeat = { every: p.every, days: [p.dow], until: end < date ? date : end, skipTournaments: true };
    else { delete item.repeat; delete item.overrides; delete item.cancelled; delete item.skip; }
    planned.set(`practice|${eid}`, item);
  }
  if (!t.practices) for (const c of copiedPractices) planned.set(`practice|${c.SK}`, c);
  puts.push(...planned.values());

  // ---------- people ----------
  const members = saved.filter((i) => String(i.SK).startsWith("MEMBER#") && i.status === "active");
  const memberEmails = new Set(members.map((m) => normEmail(String(m.email ?? ""))));
  type Inv = { email: string; firstName: string; lastName: string; roles: Set<Role>; pid?: string; staff: boolean };
  const invites = new Map<string, Inv>();
  const add = (email: string, firstName: string, lastName: string, roles: Role[], pid: string | undefined, staff: boolean) => {
    const cur = invites.get(email) ?? { email, firstName, lastName, roles: new Set<Role>(), pid: undefined, staff };
    roles.forEach((r) => cur.roles.add(r));
    cur.pid ??= pid;
    cur.staff ||= staff;
    invites.set(email, cur);
  };
  for (const s of t.staff) add(s.email, s.first, s.last, s.roles, undefined, true);
  for (const p of t.players) {
    for (const par of p.parents) {
      if (!par.invite || !par.email) continue;
      const [first, ...last] = par.name.split(/\s+/);
      const existing = invites.get(par.email);
      if (existing?.pid && existing.pid !== pidOfRow.get(p.row)) {
        problems.push({ sheet: p.sheet, row: p.row, level: "warning", message: `${par.email} is a parent of more than one player. Their account answers for the first one; a team admin can change that on the Members page.` });
      }
      add(par.email, first ?? "", last.join(" "), ["parent"], pidOfRow.get(p.row), false);
    }
  }
  const counts = { staff: 0, parents: 0, alreadyOnTeam: 0 };
  for (const inv of invites.values()) {
    if (memberEmails.has(inv.email)) { counts.alreadyOnTeam++; continue; }
    if (inv.staff) counts.staff++; else counts.parents++;
    puts.push(defined({
      ...keys.invite(inv.email, t.teamId), ...keys.inviteGsi(inv.email, t.teamId),
      type: "Invite", teamId: t.teamId, email: inv.email, roles: [...inv.roles], person: "", firstName: inv.firstName, lastName: inv.lastName, pid: inv.pid ?? "",
      invitedBy: by, at, ttl: Math.floor(Date.now() / 1000) + INVITE_DAYS * 86400
    }));
  }
  // Keep the club's team list in step with the settings.
  const savedDir = await getItem(keys.teamDir(clubId, t.teamId));
  const dir = defined({
    ...(savedDir ?? { createdAt: at, createdBy: by, archived: false }), ...keys.teamDir(clubId, t.teamId), type: "Team",
    name: settings.teamName, season: settings.season ?? "", age: settings.age ?? "", level: settings.level, program: t.program ?? savedDir?.program,
    coaches: ((settings.coaches ?? []) as Item[]).map((c) => c.name)
  });

  const summary: TeamSummary = {
    teamId: t.teamId, name: String(settings.teamName ?? t.teamId), status: isNew ? "new" : "update",
    players, events, practices: t.practices ? t.practices.length : copiedPractices.length || null, invites: counts, lists, copiedFrom
  };
  if (!write) return summary;

  if (isNew) {
    // Claim the id first, as POST /teams does, so two uploads can't both create it.
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: { ...keys.teamClub(t.teamId), type: "TeamClub", clubId, at } } },
        { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: settings } },
        { Put: { TableName: TABLE, Item: dir } },
        ...(handbook ? [{ Put: { TableName: TABLE, Item: handbook } }] : [])
      ] }));
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "TransactionCanceledException" || name === "ConditionalCheckFailedException") {
        problems.push({ ...where, level: "error", message: `Team ID "${t.teamId}" was just taken. Upload again to update it instead.` });
        return null;
      }
      throw e;
    }
  } else {
    puts.push(settings, dir);
  }
  await putMany(puts);
  return summary;
}

/** Club settings from the Club, Club links and Club admins tabs. Returns what changed, in words. */
export async function importClub(opts: { clubId: string; plan: ClubPlan; by: string; write: boolean }) {
  const { clubId, plan, by, write } = opts;
  const at = now();
  const saved = (await getItem(keys.club(clubId))) ?? {};
  const changes: string[] = [];
  const colors = { ...(saved.colors as Item | undefined), ...defined((plan.colors ?? {}) as Item) };
  if (plan.name && plan.name !== saved.name) changes.push(`Name: ${plan.name}`);
  if (plan.short && plan.short !== saved.short) changes.push(`Short name: ${plan.short}`);
  if (plan.colors?.primary || plan.colors?.accent) changes.push("Colors");
  if (plan.notes) changes.push("Notes for every team");
  if (plan.links) changes.push(`${plan.links.length} link${plan.links.length === 1 ? "" : "s"} (replacing the current ones)`);
  const admins = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :a)", ExpressionAttributeValues: { ":p": `CLUB#${clubId}`, ":a": "ADMIN#" } });
  const adminEmails = new Set(admins.map((a) => normEmail(String(a.email ?? ""))));
  const newAdmins = plan.admins.filter((a) => !adminEmails.has(a.email));
  const summary = { changes, admins: { invite: newAdmins.length, already: plan.admins.length - newAdmins.length } };
  if (!write) return summary;

  const name = plan.name ?? saved.name;
  const item = defined({
    ...saved, ...keys.club(clubId), type: "Club", clubId, name, short: plan.short ?? saved.short ?? "",
    colors: Object.keys(colors).length ? colors : undefined, links: plan.links ?? saved.links ?? [], notes: plan.notes ?? saved.notes ?? "",
    createdAt: saved.createdAt ?? at, updatedAt: at, updatedBy: by
  });
  const puts: Item[] = [item, { ...keys.clubDir(clubId), type: "ClubDir", clubId, name, createdAt: saved.createdAt ?? at }];
  for (const a of newAdmins) {
    puts.push({
      ...keys.clubInvite(a.email, clubId), ...keys.clubInviteGsi(a.email, clubId),
      type: "ClubInvite", clubId, email: a.email, role: "clubAdmin", firstName: a.firstName, lastName: a.lastName,
      invitedBy: by, at, ttl: Math.floor(Date.now() / 1000) + INVITE_DAYS * 86400
    });
  }
  await putMany(puts);
  return summary;
}

/** Teams with "Copy setup from" another team in the same file go after that team. */
export function applyOrder(teams: TeamPlan[]): string[] {
  const ids = new Set(teams.map((t) => t.teamId));
  const out: string[] = [];
  const visit = (t: TeamPlan, depth = 0) => {
    if (out.includes(t.teamId) || depth > teams.length) return;
    const src = t.copyFrom && ids.has(t.copyFrom) ? teams.find((x) => x.teamId === t.copyFrom) : undefined;
    if (src) visit(src, depth + 1);
    if (!out.includes(t.teamId)) out.push(t.teamId);
  };
  teams.forEach((t) => visit(t));
  return out;
}
