import { addDays, iso, pd, tmin } from './dates';
import type { FamilyRecord, Player, Practice, Rsvp, Settings, TeamEvent } from './models';

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
  event?: TeamEvent;
  practice?: Practice;
}

const SEASON_END = '2027-06-30';

/** Events plus every practice date, sorted by day and time. Practices skip tournament weekends. */
export function buildItems(events: TeamEvent[], settings: Settings | null): ScheduleItem[] {
  const out: ScheduleItem[] = [];
  const tournaments = events.filter((e) => e.kind === 'tournament');
  for (const e of events) {
    out.push({
      key: e.eid, kind: e.kind, title: e.title, date: e.date, end: e.endDate || e.date,
      time: e.time || '', location: e.location || e.city || '', note: e.kind === 'tournament' ? '' : e.notes || '',
      travel: !!e.travel, cancelled: false, event: e
    });
  }
  const cancelled = new Set(settings?.cancelled ?? []);
  for (const p of settings?.practices ?? []) {
    if (!p.from) continue;
    const d = pd(p.from);
    const until = pd(p.until || SEASON_END);
    for (let guard = 0; d.getDay() !== Number(p.dow) && guard < 8; guard++) d.setDate(d.getDate() + 1);
    for (let n = 0; d <= until && n < 60; d.setDate(d.getDate() + 7), n++) {
      const ds = iso(d);
      if (tournaments.some((t) => ds >= t.date && ds <= (t.endDate || t.date))) continue;
      const key = practiceKey(p.id, ds);
      out.push({
        key, kind: 'practice', title: p.label, date: ds, end: ds,
        time: p.start ? p.start + (p.end ? ` – ${p.end}` : '') : 'Time TBD',
        location: p.location || '', note: p.note || '', travel: false, cancelled: cancelled.has(key), practice: p
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || tmin(a.time) - tmin(b.time));
}

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
