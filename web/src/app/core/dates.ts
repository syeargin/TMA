// Dates are plain local calendar days ("2026-11-07"), as the hub has always stored them.

export const pd = (s: string): Date => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
export const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (s: string, n: number): string => { const d = pd(s); d.setDate(d.getDate() + n); return iso(d); };
export const today = (): string => iso(new Date());
export const daysUntil = (s: string, from = today()): number => Math.round((pd(s).getTime() - pd(from).getTime()) / 864e5);

export const fmt = (s: string | undefined, o: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  s ? pd(s).toLocaleDateString('en-US', o) : '';

/** "Sat, Nov 7" · "Nov 7–8" · "Nov 30 – Dec 1" */
export function fmtRange(a: string, b?: string): string {
  if (!b || b === a) return fmt(a);
  const A = pd(a), B = pd(b);
  const mon = (s: string) => fmt(s, { month: 'short' });
  if (A.getMonth() === B.getMonth() && A.getFullYear() === B.getFullYear()) return `${mon(a)} ${A.getDate()}–${B.getDate()}`;
  return `${mon(a)} ${A.getDate()} – ${mon(b)} ${B.getDate()}`;
}

/** Minutes after midnight for "7:30 PM" style times (0 when there's no time), for sorting. */
export function tmin(t?: string): number {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(t || '');
  if (!m) return 0;
  let h = +m[1] % 12;
  if ((m[3] || '').toUpperCase() === 'PM') h += 12;
  return h * 60 + +m[2];
}

export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
