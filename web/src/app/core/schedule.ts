import { addDays, iso, pd, tmin } from './dates';
import type { FamilyRecord, Player, Practice, Rsvp, Settings, TeamEvent } from './models';
import { Series, expandPattern } from './series';

export type ItemKind = 'tournament' | 'event' | 'deadline' | 'practice';

/** One row on the schedule: a saved event, or one date of a weekly practice. */
export interface ScheduleItem {
  key: string;            // event id, or pr-<practiceId>-<date>
  kind: ItemKind;
  title: string;
  date: string;
  end: string;
  time: string;
  location: string;
  note: string;
  travel: boolean;
  cancelled: boolean;
  /** Practices: which court and which practice uniform. */
  court?: string;
  uniformColor?: string;
  /** This date of a series was changed on its own. */
  edited?: boolean;
  event?: TeamEvent;
  practice?: Practice;
  /** Set when this date is one of a repeating series. */
  series?: Series;
}

/** Club seasons run August to June: practices with no end date stop on June 30 of the season they start in. */
export function seasonEnd(from: string): string {
  const [y, m] = from.split('-').map(Number);
  return `${m >= 7 ? y + 1 : y}-06-30`;
}

/** Events (repeating ones expanded) plus every practice date, sorted by day and time. Practices skip tournament days. */
export function buildItems(events: TeamEvent[], settings: Settings | null): ScheduleItem[] {
  const out: ScheduleItem[] = [];
  const tournaments = events.filter((e) => e.kind === 'tournament');
  const onTournament = (ds: string) => tournaments.some((t) => ds >= t.date && ds <= (t.endDate || t.date));
  for (const e of events) {
    const base = {
      kind: e.kind, title: e.title, time: timeText(e.time, e.endTime), location: e.location || e.city || '',
      note: e.kind === 'tournament' ? '' : e.notes || '', travel: !!e.travel, event: e,
      court: e.court || undefined, uniformColor: e.uniformColor || undefined
    };
    if (!e.repeat) {
      out.push({ ...base, key: e.eid, date: e.date, end: e.endDate || e.date, cancelled: false });
      continue;
    }
    const r = e.repeat;
    const dates = expandPattern(e.date, r.until, r.days, r.every);
    const skip = new Set(e.skip ?? []);
    const shown = dates.filter((d) => !skip.has(d) && !(r.skipTournaments !== false && onTournament(d)));
    const cancelled = new Set(e.cancelled ?? []);
    const series: Series = { id: e.eid, source: 'event', every: r.every, days: r.days, until: r.until, dates, active: shown.filter((d) => !cancelled.has(d)) };
    for (const d of shown) {
      out.push({ ...base, ...occurrence(e, d), key: `${e.eid}-${d}`, date: d, end: d, cancelled: cancelled.has(d), series });
    }
  }
  const cancelled = new Set(settings?.cancelled ?? []);
  for (const p of settings?.practices ?? []) {
    if (!p.from) continue;
    const until = p.until || seasonEnd(p.from);
    const dates = expandPattern(p.from, until, [Number(p.dow)], 1);
    const shown = dates.filter((d) => !onTournament(d));
    const series: Series = {
      id: p.id, source: 'practice', every: 1, days: [Number(p.dow)], until, dates,
      active: shown.filter((d) => !cancelled.has(practiceKey(p.id, d)))
    };
    for (const ds of shown) {
      const key = practiceKey(p.id, ds);
      out.push({
        key, kind: 'practice', title: p.label, date: ds, end: ds,
        time: p.start ? p.start + (p.end ? ` – ${p.end}` : '') : 'Time TBD',
        location: p.location || '', note: p.note || '', travel: false, cancelled: cancelled.has(key), practice: p, series
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || tmin(a.time) - tmin(b.time));
}

/** "6:30 PM – 8:30 PM", or just the start. */
export const timeText = (start?: string, end?: string) => (start ? start + (end ? ` – ${end}` : '') : '');

/** What one date of a series shows: the series, with that date's own changes on top. */
export function occurrence(e: TeamEvent, date: string): Partial<ScheduleItem> {
  const o = e.overrides?.[date];
  if (!o || !Object.values(o).some(Boolean)) return {};
  const out: Partial<ScheduleItem> = { edited: true };
  if (o.title) out.title = o.title;
  if (o.time || o.endTime) out.time = timeText(o.time || e.time, o.endTime || e.endTime);
  if (o.location) out.location = o.location;
  if (o.court) out.court = o.court;
  if (o.uniformColor) out.uniformColor = o.uniformColor;
  if (o.notes) out.note = o.notes;
  return out;
}

/** "Court 3" for a number, otherwise as typed ("Courts 3–4", "Aux gym"). */
export const courtLabel = (c?: string) => (!c ? '' : /^\d+[a-z]?$/i.test(c.trim()) ? `Court ${c.trim()}` : c.trim());

export const practiceKey = (practiceId: string, date: string) => `pr-${practiceId}-${date}`;

/** Deadlines don't take availability; everything else does. */
export const takesRsvp = (it: ScheduleItem) => it.kind !== 'deadline';

export const rsvpOf = (family: Record<string, FamilyRecord>, pid: string, key: string): Rsvp | '' =>
  family[pid]?.rsvp?.[key]?.v ?? '';

export interface Counts { yes: number; maybe: number; no: number; none: number }
export function countsFor(players: Player[], family: Record<string, FamilyRecord>, key: string): Counts {
  const c: Counts = { yes: 0, maybe: 0, no: 0, none: 0 };
  for (const p of players) c[rsvpOf(family, p.pid, key) || 'none']++;
  return c;
}

export const upcoming = (items: ScheduleItem[], from: string) => items.filter((i) => i.end >= from);
export const within = (items: ScheduleItem[], from: string, days: number) => items.filter((i) => i.end >= from && i.date <= addDays(from, days));
