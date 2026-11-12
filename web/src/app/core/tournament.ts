import { addDays, tmin } from './dates';
import { familyTaskFrom } from '@shared/dayplans';
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

export { money, toCents } from './money';

export const sortMeals = (meals: Meal[]) =>
  [...meals].sort((a, b) => String(a.day ?? '').localeCompare(String(b.day ?? '')) || tmin(a.time) - tmin(b.time));

/** Only http(s) links become links; anything else shows as text. */
export const safeUrl = (v?: string) => (v && /^https?:\/\//i.test(v.trim()) ? v.trim() : '');
export const shortUrl = (v: string) => v.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 60);

export interface Duty { label: string; pid: string }
/**
 * Who brings the ball cart and the volleyballs. Each is a player id or "na" (not needed). Events saved before the
 * two were split have one dutyPid for both. Returns one combined line when the same family has both.
 */
export function duties(e: { cartPid?: string; ballsPid?: string; dutyPid?: string }): Duty[] {
  const cart = e.cartPid ?? e.dutyPid ?? '';
  const balls = e.ballsPid ?? e.dutyPid ?? '';
  if (cart && cart === balls) return [{ label: 'Balls & cart', pid: cart }];
  return [{ label: 'Ball cart', pid: cart }, { label: 'Volleyballs', pid: balls }].filter((d) => d.pid);
}

/** "Fri 6:00 PM" from "2027-01-29T18:00". */
export function orderByLabel(v?: string): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
/** When this meal's "add your order" to-do starts for families (ms), or null without a link. */
export function taskStart(m: Meal, leadHours: number): number | null {
  if (!m.familyOrders || !m.orderLink) return null;
  return familyTaskFrom(m.linkAt ? Date.parse(m.linkAt) : Date.now(), m.orderBy ? new Date(m.orderBy).getTime() : null, leadHours);
}

