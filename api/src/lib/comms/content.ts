/**
 * What goes in the weekly at-a-glance and the staff digest, from the team's own records. Each person
 * gets only what their role can already see on the site (the same permission table, shared/permissions),
 * and only for features the team has on.
 */
import { reviewItems } from "../../shared/feed-rules.js";
import { getControls } from "../club-controls.js";
import { getClub, type Club } from "../clubs.js";
import { queryAll } from "../../api/util.js";
import { effectiveFeatures, isOn, type Feature, type FeatureMap } from "../../shared/features.js";
import { can, type Permission } from "../../shared/permissions.js";
import { addDays, between, buildItems, shortDate, takesRsvp, type Item } from "./schedule.js";

type Row = Record<string, unknown>;
export const str = (v: unknown) => (typeof v === "string" ? v : "");

export type Member = { sub: string; roles: string[]; pid: string; email: string; firstName: string; notifyOff: string[] };
export type Team = {
  teamId: string; clubId: string; club: Club | null; settings: Row; teamName: string; features: FeatureMap;
  players: Row[]; events: Row[]; meals: Row[]; family: Record<string, Row>; ledger: Row[]; announcements: Row[]; tasks: Row[];
  members: Member[]; items: Item[];
};

export async function loadTeam(teamId: string, clubId: string): Promise<Team> {
  const rows = await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `TEAM#${teamId}` } });
  const t: Team = {
    teamId, clubId, club: await getClub(clubId), settings: {}, teamName: teamId, features: {},
    players: [], events: [], meals: [], family: {}, ledger: [], announcements: [], tasks: [], members: [], items: []
  };
  for (const r of rows) {
    const sk = String(r.SK);
    if (sk === "META#SETTINGS") t.settings = r;
    else if (sk.startsWith("PLAYER#") && !sk.endsWith("#CONTACTS")) t.players.push({ ...r, pid: sk.slice(7) });
    else if (sk.startsWith("EVENT#")) {
      const parts = sk.split("#");
      if (parts.length === 2) t.events.push({ ...r, eid: parts[1] });
      else if (parts[2] === "MEAL") t.meals.push({ ...r, eid: parts[1], mid: parts[3] });
    }
    else if (sk.startsWith("FAMILY#")) t.family[sk.slice(7)] = r;
    else if (sk.startsWith("LEDGER#")) t.ledger.push(r);
    else if (sk.startsWith("ANN#")) t.announcements.push(r);
    else if (sk.startsWith("TASK#")) t.tasks.push(r);
    else if (sk.startsWith("MEMBER#") && r.status === "active") {
      t.members.push({
        sub: sk.slice(7), roles: (r.roles as string[]) ?? [], pid: str(r.pid), email: str(r.email),
        firstName: str(r.firstName), notifyOff: (r.notifyOff as string[]) ?? []
      });
    }
  }
  t.teamName = str(t.settings.teamName) || teamId;
  // A feature works only if the team and its club both allow it (site admin dashboard).
  t.features = effectiveFeatures(t.settings.features as FeatureMap, (await getControls(clubId)).features);
  t.items = buildItems(t.events, t.settings);
  return t;
}

export const has = (t: Team, f: Feature) => isOn(t.features, f);
const allowed = (m: Member, p: Permission) => can(m.roles, p);
export const STAFF = ["admin", "coach", "coordinator", "food", "finance"];
export const isStaff = (m: Member) => m.roles.some((r) => STAFF.includes(r));

/** "Ella M." */
export function playerShort(p: Row | undefined): string {
  if (!p) return "";
  const last = str(p.last);
  return `${str(p.first)}${last ? ` ${last[0]}.` : ""}`.trim();
}

export const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** The week an email covers: the 7 days after the day it's sent. */
export const weekOf = (sendDate: string) => ({ from: addDays(sendDate, 1), to: addDays(sendDate, 7) });
export const weekLabel = (w: { from: string; to: string }) => `${shortDate(w.from)} – ${shortDate(w.to)}`;

export function duesOwed(t: Team, pid: string): number {
  const dues = t.settings.dues as { amountCents?: number } | undefined;
  const amount = Number(dues?.amountCents ?? 0);
  if (!amount) return 0;
  const paid = t.ledger.filter((l) => l.kind === "in" && l.cat === "Dues" && l.pid === pid && l.status !== "declined").reduce((n, l) => n + Number(l.amountCents ?? 0), 0);
  return Math.max(0, amount - paid);
}

/** Dues worth mentioning: due within three weeks of the email, or already past. */
function duesSoon(t: Team, sendDate: string): string | null {
  const due = str((t.settings.dues as Row | undefined)?.due);
  if (!due || due > addDays(sendDate, 21)) return null;
  return due;
}

const itemView = (i: Item) => ({ date: shortDate(i.date), title: i.title, time: i.time, location: i.location, cancelled: i.cancelled, kind: i.kind, ...(i.changed && !i.cancelled ? { changed: i.changed } : {}) });

export type WeeklyContent = {
  week: string;
  items: ReturnType<typeof itemView>[];
  needs: { date: string; title: string; time: string }[];
  meals: { date: string; meal: string; event: string }[];
  dues: { amount: string; due: string; late: boolean } | null;
  pinned: string[];
  playerFirst: string;
};

/** A family's week (pid), or the team's week for staff who aren't parents (no pid). */
export function weeklyContent(t: Team, m: Member, sendDate: string): WeeklyContent {
  const w = weekOf(sendDate);
  const week = between(t.items, w.from, w.to);
  const pid = m.roles.includes("parent") ? m.pid : "";
  const player = t.players.find((p) => p.pid === pid);
  const rsvp = (pid ? (t.family[pid]?.rsvp as Record<string, unknown> | undefined) : undefined) ?? {};
  const needs = pid ? week.filter((i) => takesRsvp(i) && !i.cancelled && !rsvp[i.key]).map((i) => ({ date: shortDate(i.date), title: i.title, time: i.time })) : [];
  const eventTitle = (eid: string) => str(t.events.find((e) => e.eid === eid)?.title);
  const weekEids = new Set(week.map((i) => i.eid).filter(Boolean));
  const meals = pid && has(t, "meals")
    ? t.meals.filter((x) => x.claimedBy === pid && weekEids.has(str(x.eid))).map((x) => ({ date: x.day ? shortDate(str(x.day)) : "", meal: str(x.meal), event: eventTitle(str(x.eid)) }))
    : [];
  let dues: WeeklyContent["dues"] = null;
  const due = duesSoon(t, sendDate);
  if (pid && due && has(t, "fund")) {
    const owed = duesOwed(t, pid);
    if (owed > 0) dues = { amount: money(owed), due: shortDate(due), late: due < sendDate };
  }
  const pinned = t.announcements.filter((a) => a.pinned).map((a) => str(a.text)).filter(Boolean).slice(0, 3);
  return { week: weekLabel(w), items: week.map(itemView), needs, meals, dues, pinned, playerFirst: str(player?.first) };
}

/** Pinned posts alone don't make a week worth an email: they're the same every week. */
export const weeklyIsEmpty = (c: WeeklyContent) => !c.items.length && !c.needs.length && !c.dues;

export type StaffContent = {
  week: string;
  unanswered: { date: string; title: string; names: string[] }[] | null;
  openMeals: { date: string; meal: string; event: string }[] | null;
  travelMissing: { date: string; title: string; families: string[] }[] | null;
  dues: { due: string; families: string[] } | null;
  tasks: { title: string; owner: string; status: string }[] | null;
  /** Calendar feed sync: what the club's calendar changed this past week on things still coming up, and (for feed admins) what needs review. */
  feed?: { changes: { date: string; title: string; text: string }[]; review: number } | null;
};

/** What's still open this week, by what this person's roles can see. A null section is one they don't get. */
export function staffContent(t: Team, m: Member, sendDate: string): StaffContent {
  const w = weekOf(sendDate);
  const week = between(t.items, w.from, w.to).filter((i) => !i.cancelled);
  const answered = (pid: string, key: string) => !!(t.family[pid]?.rsvp as Record<string, unknown> | undefined)?.[key];
  const out: StaffContent = { week: weekLabel(w), unanswered: null, openMeals: null, travelMissing: null, dues: null, tasks: null };
  if (allowed(m, "attendance")) {
    out.unanswered = week.filter(takesRsvp).map((i) => ({
      date: shortDate(i.date), title: i.title,
      names: t.players.filter((p) => !answered(str(p.pid), i.key)).map(playerShort)
    })).filter((x) => x.names.length);
  }
  if (allowed(m, "meals") && has(t, "meals")) {
    const eids = new Set(week.map((i) => i.eid));
    out.openMeals = t.meals.filter((x) => !x.claimedBy && eids.has(str(x.eid)))
      .map((x) => ({ date: x.day ? shortDate(str(x.day)) : "", meal: str(x.meal), event: str(t.events.find((e) => e.eid === x.eid)?.title) }));
  }
  if (allowed(m, "roster") && has(t, "travel")) {
    // Travel tournaments in the next three weeks, so families have time to plan.
    const soon = between(t.items, w.from, addDays(sendDate, 21)).filter((i) => i.kind === "tournament" && i.travel && !i.cancelled);
    out.travelMissing = soon.map((i) => ({
      date: shortDate(i.date), title: i.title,
      families: t.players.filter((p) => !(t.family[str(p.pid)]?.travel as Record<string, unknown> | undefined)?.[i.key]).map(playerShort)
    })).filter((x) => x.families.length);
  }
  if (allowed(m, "ledger") && has(t, "fund")) {
    const due = duesSoon(t, sendDate);
    const families = due ? t.players.filter((p) => duesOwed(t, str(p.pid)) > 0).map(playerShort) : [];
    out.dues = due && families.length ? { due: shortDate(due), families } : null;
  }
  if (allowed(m, "tasks") && has(t, "tasks")) {
    out.tasks = t.tasks.filter((k) => k.status !== "Done" && k.status !== "N/A")
      .sort((a, b) => Number(a.order ?? 999) - Number(b.order ?? 999))
      .map((k) => ({ title: str(k.title), owner: str(k.owner), status: str(k.status) || "To do" }));
  }
  if (allowed(m, "schedule") && has(t, "calfeed") && t.events.some((e) => e.src)) {
    const changes = t.items.filter((i) => i.changed && i.end >= sendDate).map((i) => ({ date: shortDate(i.date), title: i.title, text: i.cancelled ? "cancelled" : String(i.changed) }));
    const review = allowed(m, "calendarFeed") ? reviewItems(t.events as Parameters<typeof reviewItems>[0], sendDate).length : 0;
    out.feed = changes.length || review ? { changes, review } : null;
  }
  return out;
}

export const staffIsEmpty = (c: StaffContent) =>
  !(c.unanswered?.length || c.openMeals?.length || c.travelMissing?.length || c.dues || c.tasks?.length || c.feed);

/** Who gets a message, with the version each gets. Opt-outs and the team's audience choices applied. */
export function recipients(t: Team, msg: "weekly" | "staffDigest", audience: Record<string, boolean>): Member[] {
  return t.members.filter((m) => {
    if (m.notifyOff.includes(msg) || m.notifyOff.includes("all")) return false;
    if (msg === "weekly") return (m.roles.includes("parent") && audience.parent) || (!m.roles.includes("parent") && isStaff(m) && audience.staff);
    return m.roles.some((r) => STAFF.includes(r) && audience[r]);
  });
}
