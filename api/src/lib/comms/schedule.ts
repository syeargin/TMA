/**
 * The team's schedule as the site shows it, worked out on the server for emails: events with repeating
 * ones expanded, plus older weekly practice times, practices left off tournament days. A port of
 * web/src/app/core/schedule.ts buildItems(); test/comms/schedule.test.ts runs both on the same data so
 * an email never shows a different week from the site.
 */
type Row = Record<string, unknown>;

// Dates are plain calendar days ("2026-11-07"), as the site stores them.
export const pd = (s: string): Date => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
export const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (s: string, n: number): string => { const d = pd(s); d.setDate(d.getDate() + n); return iso(d); };

/** Minutes after midnight for "7:30 PM" (0 when there's no time), for sorting. */
export function tmin(t?: string): number {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(t || "");
  if (!m) return 0;
  let h = +m[1] % 12;
  if ((m[3] || "").toUpperCase() === "PM") h += 12;
  return h * 60 + +m[2];
}

const MAX = 400;
export function expandPattern(start: string, until: string, days: number[], every = 1): string[] {
  const out: string[] = [];
  const s = pd(start);
  const week0 = new Date(s); week0.setDate(s.getDate() - s.getDay());
  const want = new Set(days.map(Number));
  for (let d = new Date(s); iso(d) <= until && out.length < MAX; d.setDate(d.getDate() + 1)) {
    const weekIdx = Math.floor(Math.round((d.getTime() - week0.getTime()) / 864e5) / 7);
    if (want.has(d.getDay()) && weekIdx % Math.max(1, every) === 0) out.push(iso(d));
  }
  return out;
}

export function seasonEnd(from: string): string {
  const [y, m] = from.split("-").map(Number);
  return `${m >= 7 ? y + 1 : y}-06-30`;
}

export const timeText = (start?: unknown, end?: unknown) => (start ? String(start) + (end ? ` – ${end}` : "") : "");

export interface Item {
  key: string; kind: string; title: string; date: string; end: string; time: string; location: string;
  note: string; travel: boolean; cancelled: boolean; eid?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function occurrence(e: Row, date: string): Partial<Item> {
  const o = (e.overrides as Record<string, Row> | undefined)?.[date];
  if (!o || !Object.values(o).some(Boolean)) return {};
  const out: Partial<Item> = {};
  if (o.title) out.title = str(o.title);
  if (o.time || o.endTime) out.time = timeText(o.time || e.time, o.endTime || e.endTime);
  if (o.location) out.location = str(o.location);
  if (o.notes) out.note = str(o.notes);
  return out;
}

export function buildItems(events: Row[], settings: Row | null): Item[] {
  const out: Item[] = [];
  const tournaments = events.filter((e) => e.kind === "tournament");
  const onTournament = (ds: string) => tournaments.some((t) => ds >= str(t.date) && ds <= (str(t.endDate) || str(t.date)));
  for (const e of events) {
    const eid = str(e.eid);
    const base = {
      kind: str(e.kind), title: str(e.title), time: timeText(e.time, e.endTime), location: str(e.location) || str(e.city),
      note: e.kind === "tournament" ? "" : str(e.notes), travel: !!e.travel, eid
    };
    const r = e.repeat as { every: number; days: number[]; until: string; skipTournaments?: boolean } | undefined;
    // A one-time event is cancelled when its date is in its cancelled list (events from a calendar feed).
    if (!r) { out.push({ ...base, key: eid, date: str(e.date), end: str(e.endDate) || str(e.date), cancelled: ((e.cancelled as string[] | undefined) ?? []).includes(str(e.date)) }); continue; }
    const skip = new Set((e.skip as string[] | undefined) ?? []);
    const cancelled = new Set((e.cancelled as string[] | undefined) ?? []);
    for (const d of expandPattern(str(e.date), r.until, r.days, r.every)) {
      if (skip.has(d) || (r.skipTournaments !== false && onTournament(d))) continue;
      out.push({ ...base, ...occurrence(e, d), key: `${eid}-${d}`, date: d, end: d, cancelled: cancelled.has(d) });
    }
  }
  const cancelled = new Set((settings?.cancelled as string[] | undefined) ?? []);
  for (const p of (settings?.practices as Row[] | undefined) ?? []) {
    if (!p.from) continue;
    const until = str(p.until) || seasonEnd(str(p.from));
    for (const ds of expandPattern(str(p.from), until, [Number(p.dow)], 1)) {
      if (onTournament(ds)) continue;
      const key = `pr-${str(p.id)}-${ds}`;
      out.push({
        key, kind: "practice", title: str(p.label), date: ds, end: ds,
        time: p.start ? str(p.start) + (p.end ? ` – ${str(p.end)}` : "") : "Time TBD",
        location: str(p.location), note: str(p.note), travel: false, cancelled: cancelled.has(key)
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || tmin(a.time) - tmin(b.time));
}

/** Deadlines don't take availability; everything else does. */
export const takesRsvp = (it: Item) => it.kind !== "deadline";

/** Items happening from `from` through `to` (inclusive). */
export const between = (items: Item[], from: string, to: string) => items.filter((i) => i.end >= from && i.date <= to);

/** "Tue, Oct 27" */
export const shortDate = (s: string) => pd(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
