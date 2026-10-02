import { addDays, iso, pd } from './dates';
import type { TeamEvent } from './models';

export interface Repeat { every: number; days: number[]; until: string; skipTournaments?: boolean }

/** A repeating set of dates: a weekly practice time, or an event saved with "Repeat". */
export interface Series {
  id: string;
  source: 'practice' | 'event';
  every: number;
  days: number[];
  until: string;
  /** Every date the pattern produces, first to last. */
  dates: string[];
  /** The dates that actually happen (not cancelled, skipped, or on a tournament day). */
  active: string[];
}

const MAX = 400;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Dates from start to until on the given weekdays, every N weeks (weeks run Sunday–Saturday from the start's week). */
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

export function describe(s: Pick<Series, 'every' | 'days' | 'until'>, long = false): string {
  const names = [...s.days].sort().map((d) => (long ? DAY_LONG : DAY)[d]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0];
  const how = s.every === 1 ? 'Weekly' : `Every ${s.every} weeks`;
  const until = pd(s.until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${how} on ${list} until ${until}`;
}
export const shortLabel = (s: Pick<Series, 'every'>) => (s.every === 1 ? 'Weekly' : `Every ${s.every} wks`);

/** Something on the schedule several times that looks like one repeating event. */
export interface PatternSuggestion {
  eids: string[]; title: string; time: string; location: string;
  repeat: Repeat; skip: string[]; count: number;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const norm = (s?: string) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Finds one-time events with the same name, time and place that fall on the same weekday(s) at a weekly
 * (or every-other-week) rhythm. Missing weeks (often tournament weekends) become skipped dates.
 */
export function findPatterns(events: TeamEvent[]): PatternSuggestion[] {
  const groups = new Map<string, TeamEvent[]>();
  for (const e of events) {
    if (e.kind !== 'event' || e.repeat || e.endDate && e.endDate !== e.date) continue;
    const k = `${norm(e.title)}|${norm(e.time)}|${norm(e.location)}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const out: PatternSuggestion[] = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const sorted = [...g].sort((a, b) => a.date.localeCompare(b.date));
    const dates = sorted.map((e) => e.date);
    if (new Set(dates).size !== dates.length) continue;
    const days = [...new Set(dates.map((d) => pd(d).getDay()))].sort();
    if (days.length > 3) continue;
    let every = 1;
    if (days.length === 1) {
      const gaps = dates.slice(1).map((d, i) => Math.round((pd(d).getTime() - pd(dates[i]).getTime()) / 864e5 / 7));
      every = gaps.reduce((a, b) => gcd(a, b), 0);
      if (every < 1 || every > 2) continue;
    }
    const first = dates[0], last = dates.at(-1)!;
    const expected = expandPattern(first, last, days, every);
    const have = new Set(dates);
    if (!dates.every((d) => expected.includes(d))) continue;
    const skip = expected.filter((d) => !have.has(d));
    if (skip.length > dates.length / 2) continue;
    out.push({
      eids: sorted.map((e) => e.eid), title: sorted[0].title, time: sorted[0].time ?? '', location: sorted[0].location ?? '',
      repeat: { every, days, until: last, skipTournaments: true }, skip, count: dates.length
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export const seasonEnd = (from: string) => addDays(from, 365);
