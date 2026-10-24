/**
 * Times in a team's time zone. Lambda runs in UTC; a team's "Sunday at 6 PM" is local to the team,
 * including daylight saving changes.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    fmtCache.set(tz, f);
  }
  return f;
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local calendar day, time and weekday of an instant. */
export function localParts(at: Date, tz: string): { date: string; hhmm: string; dow: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, dow: DOW[p.weekday] ?? 0 };
}

/** How far the zone is ahead of UTC at an instant, in ms. */
function offset(at: number, tz: string): number {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a local day and time ("2026-10-25", "18:00") happens in the zone. */
export function zonedInstant(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offset(guess, tz);
  t = guess - offset(t, tz); // once more, for days when the clocks change
  return new Date(t);
}

/** The local days from `from` on, `n` of them. */
export function nextDays(from: string, n: number): string[] {
  const out: string[] = [];
  const [y, m, d] = from.split("-").map(Number);
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  return out;
}

export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
