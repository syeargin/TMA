/**
 * Messaging M2b: what's due for the "days before" messages (tournament packet, availability reminder,
 * dues reminder), and what goes in each person's email. Like the weekly email, everything comes from the
 * team's records and only what the person's role can already see.
 */
import { isOn } from "../../shared/features.js";
import type { effective } from "../../shared/messages.js";
import { duesOwed, has, isStaff, money, playerShort, str, type Member, type Team } from "./content.js";
import { addDays, shortDate, takesRsvp, type Item } from "./schedule.js";
import { signAnswer } from "./tokens.js";

type Eff = NonNullable<ReturnType<typeof effective>>;
type Row = Record<string, unknown>;
export type ReminderMsg = "packet" | "availability" | "dues";

/** One reminder send: which day it goes, its key (so it goes once), and what it's about. */
export type Target = { msg: ReminderMsg; sendDate: string; key: string; label: string; itemKeys?: string[]; eid?: string; due?: string; late?: boolean };

const range = (a: string, b?: string) => (b && b !== a ? `${shortDate(a)} – ${shortDate(b)}` : shortDate(a));

export function targets(t: Team, msg: ReminderMsg, e: Eff): Target[] {
  if (msg === "packet") {
    return t.items.filter((i) => i.kind === "tournament" && !i.cancelled && (!e.rules.travelOnly || i.travel)).map((i) => ({
      msg, sendDate: addDays(i.date, -e.days), key: `packet:${i.eid}`, eid: i.eid, label: `Tournament packet: ${i.title}`
    }));
  }
  if (msg === "availability") {
    const byDay = new Map<string, Item[]>();
    for (const i of t.items) {
      if (!takesRsvp(i) || i.cancelled || (e.rules.tournamentsOnly && i.kind !== "tournament")) continue;
      const d = addDays(i.date, -e.days);
      byDay.set(d, [...(byDay.get(d) ?? []), i]);
    }
    return [...byDay].map(([sendDate, items]) => ({
      msg, sendDate, key: `availability:${sendDate}`, itemKeys: items.map((i) => i.key),
      label: `Availability reminder: ${items.map((i) => i.title).join(", ")}`
    }));
  }
  if (!has(t, "fund")) return [];
  const due = str((t.settings.dues as Row | undefined)?.due);
  if (!due || !Number((t.settings.dues as Row | undefined)?.amountCents)) return [];
  const out: Target[] = [{ msg, sendDate: addDays(due, -e.days), key: `dues:${due}`, due, label: `Dues reminder: due ${shortDate(due)}` }];
  if (e.rules.late) out.push({ msg, sendDate: addDays(due, 1), key: `dues-late:${due}`, due, late: true, label: `Dues reminder: a day late` });
  return out;
}

/** Families (parents) and, where the team chose, staff who aren't parents. Opt-outs left out. */
export function audienceFor(t: Team, msg: string, audience: Record<string, boolean>): Member[] {
  return t.members.filter((m) => {
    if (m.notifyOff.includes(msg) || m.notifyOff.includes("all")) return false;
    const parent = m.roles.includes("parent") && !!m.pid;
    return (parent && audience.parent) || (!parent && isStaff(m) && !!audience.staff);
  });
}

// ---------- tournament packet ----------

export type PacketContent = {
  eid: string; title: string; dates: string; place: string; travel: boolean;
  rows: { label: string; value: string }[];
  bring: string[];
  hotel: { name: string; by: string; code: string; link: string } | null;
  travelMissing: boolean;
  jobs: string[];
  playerFirst: string;
};

export function packetContent(t: Team, m: Member, eid: string): PacketContent | null {
  const e = t.events.find((x) => x.eid === eid);
  if (!e) return null;
  const pid = m.roles.includes("parent") ? m.pid : "";
  const player = t.players.find((p) => p.pid === pid);
  const place = [str(e.location), str(e.address) || str(e.city)].filter(Boolean).join(", ");
  const rows = ([
    ["Arrive", e.arrival], ["First match", e.start], ["Meet", e.meet], ["Wear", e.uniforms], ["Waves", e.waves],
    ["Parking", e.parking], ["Admission", e.admissions], ["Team code", e.teamCode]
  ] as [string, unknown][]).filter(([, v]) => str(v)).map(([label, v]) => ({ label, value: str(v) }));
  const jobs: string[] = [];
  if (pid) {
    if (e.cartPid === pid) jobs.push("Your family brings the ball cart.");
    if (e.ballsPid === pid || e.dutyPid === pid) jobs.push("Your family brings the volleyballs.");
    if (has(t, "meals")) for (const meal of t.meals.filter((x) => x.eid === eid && x.claimedBy === pid)) jobs.push(`You signed up for ${str(meal.meal)}${meal.day ? ` (${shortDate(str(meal.day))})` : ""}.`);
  }
  const travel = !!e.travel && has(t, "travel");
  const plans = pid ? (t.family[pid]?.travel as Row | undefined) ?? {} : {};
  return {
    eid, title: str(e.title), dates: range(str(e.date), str(e.endDate)), place, travel, rows,
    bring: ((e.checklist as string[] | undefined) ?? []).filter(Boolean).slice(0, 20),
    hotel: travel && e.hotel ? { name: str(e.hotel), by: str(e.hotelBy), code: str(e.hotelCode), link: str(e.hotelLink) } : null,
    travelMissing: travel && !!pid && !plans[eid],
    jobs, playerFirst: str(player?.first)
  };
}

// ---------- availability reminder ----------

export type AvailabilityContent = {
  playerFirst: string;
  items: { date: string; title: string; time: string; location: string; links: { yes: string; maybe: string; no: string } }[];
};

/** The dates this family hasn't answered, each with signed In / Maybe / Out links. Empty when they've answered everything. */
export async function availabilityContent(t: Team, m: Member, itemKeys: string[], siteUrl: string): Promise<AvailabilityContent> {
  const pid = m.pid;
  const rsvp = (t.family[pid]?.rsvp as Row | undefined) ?? {};
  const player = t.players.find((p) => p.pid === pid);
  const items = t.items.filter((i) => itemKeys.includes(i.key) && !rsvp[i.key]);
  const out: AvailabilityContent = { playerFirst: str(player?.first), items: [] };
  for (const i of items) {
    // Works until the end of the day after the event (UTC), then the link says it's too late.
    const exp = Math.floor(Date.parse(`${addDays(i.end, 2)}T00:00:00Z`) / 1000);
    const link = async (v: "yes" | "maybe" | "no") => `${siteUrl}/answer#t=${await signAnswer({ sub: m.sub, teamId: t.teamId, pid, key: i.key, v, exp })}`;
    out.items.push({ date: shortDate(i.date), title: i.title, time: i.time, location: i.location, links: { yes: await link("yes"), maybe: await link("maybe"), no: await link("no") } });
  }
  return out;
}

// ---------- dues reminder ----------

export type DuesContent = { playerFirst: string; owed: string; total: string; paid: string; due: string; label: string; late: boolean };

export function duesContent(t: Team, m: Member, due: string, late: boolean): DuesContent | null {
  const owed = duesOwed(t, m.pid);
  if (!owed) return null;
  const total = Number((t.settings.dues as Row | undefined)?.amountCents ?? 0);
  const player = t.players.find((p) => p.pid === m.pid);
  return {
    playerFirst: str(player?.first), owed: money(owed), total: money(total), paid: money(total - owed), due: shortDate(due),
    label: str((t.settings.dues as Row | undefined)?.label) || "Dues", late
  };
}

export const featureOn = (t: Team, f: "fund") => isOn(t.features, f);
export { playerShort };
