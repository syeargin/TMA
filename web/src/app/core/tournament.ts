import { addDays, tmin } from './dates';
import type { Meal, Player, RefAssign, RefSet } from './models';

export const REF_SETS: RefSet[] = ['s1', 's2', 's3'];
export const REF_JOBS = ['Book', 'Score', 'Libero', 'Lines', 'Off', 'Playing'];
export const MEAL_KINDS = ['Breakfast', 'Lunch', 'Dinner', 'Coach snacks & drinks', 'Team snack'];
export const TRAVEL_MODES = ['Driving', 'Flying', 'Carpool', 'Not attending'];

export const refGroup = (p: Player): 'A' | 'B' => (p.refTeam === 'B' ? 'B' : 'A');

/**
 * Each player covers one job per set, rotating through the group so the jobs move around
 * (same rule as the claude.ai hub).
 */
export function fillByRotation(players: Player[]): RefAssign {
  const jobs = ['Book', 'Score', 'Libero', 'Lines', 'Lines', 'Off'];
  const out: RefAssign = {};
  for (const g of ['A', 'B'] as const) {
    const ps = players.filter((p) => refGroup(p) === g);
    ps.forEach((p, i) => {
      out[p.pid] = {};
      REF_SETS.forEach((s, si) => { out[p.pid][s] = jobs[(i + si * 2) % ps.length] || 'Off'; });
    });
  }
  return out;
}

/** Every day of a tournament, for the meal day picker. */
export function tournamentDays(date: string, end?: string): string[] {
  const out: string[] = [];
  for (let d = date; d <= (end || date) && out.length < 10; d = addDays(d, 1)) out.push(d);
  return out;
}

export const money = (cents: number) =>
  (cents < 0 ? '−$' : '$') + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });

/** "12.50" → 1250; blank or bad → 0 */
export const toCents = (v: string | number | null | undefined) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

export const sortMeals = (meals: Meal[]) =>
  [...meals].sort((a, b) => String(a.day ?? '').localeCompare(String(b.day ?? '')) || tmin(a.time) - tmin(b.time));

/** Only http(s) links become links; anything else shows as text. */
export const safeUrl = (v?: string) => (v && /^https?:\/\//i.test(v.trim()) ? v.trim() : '');
export const shortUrl = (v: string) => v.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 60);
