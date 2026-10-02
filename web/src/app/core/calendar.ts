import { addDays, pd, today } from './dates';
import type { ScheduleItem } from './schedule';

/** One schedule item as a calendar entry. All-day entries use an exclusive end date, as calendars expect. */
export interface CalEvent {
  title: string; location: string; details: string; uid: string;
  allDay: boolean;
  /** all-day: YYYY-MM-DD (end is the day after the last day) */
  startDate: string; endDate: string;
  /** timed: local times */
  start?: Date; end?: Date;
  /** series only: repeat rule and the dates it skips */
  rrule?: string;
  exdates?: string[];
}

const TIME = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i;
function at(date: string, t: string): Date | null {
  const m = TIME.exec(t);
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  const d = pd(date);
  d.setHours(h, +(m[2] ?? 0), 0, 0);
  return d;
}

export function toCalEvent(it: ScheduleItem, link: string): CalEvent {
  const base = {
    title: it.kind === 'practice' && !/practice/i.test(it.title) ? `${it.title} practice` : it.title,
    location: it.location,
    details: [it.note, `Team Hub: ${link}`].filter(Boolean).join('\n\n'),
    uid: `${it.key}@a5-team-hub`
  };
  const allDay = { ...base, allDay: true, startDate: it.date, endDate: addDays(it.end || it.date, 1) };
  if (it.kind === 'tournament' || it.kind === 'deadline') return allDay;
  const [from, to] = it.time.split(/\s+[–-]\s+/);
  const start = at(it.date, from ?? '');
  if (!start) return allDay;
  let end = to ? at(it.date, to) : null;
  if (!end || end <= start) end = new Date(start.getTime() + 2 * 3600_000);
  return { ...base, allDay: false, startDate: it.date, endDate: it.date, start, end };
}

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * The whole series as one repeating calendar entry, starting from its next date (today or later).
 * Cancelled dates, skipped weeks and tournament days become exceptions. Null if no dates are left.
 */
export function toSeriesCalEvent(it: ScheduleItem, link: string, from = today()): CalEvent | null {
  const s = it.series;
  if (!s) return null;
  const startDate = s.active.find((d) => d >= from);
  if (!startDate) return null;
  const base = toCalEvent({ ...it, date: startDate, end: startDate, cancelled: false }, link);
  const active = new Set(s.active);
  const exdates = s.dates.filter((d) => d > startDate && !active.has(d));
  let until: string;
  if (base.allDay) until = compact(s.until);
  else { const u = pd(s.until); u.setHours(23, 59, 59, 0); until = utc(u).replace(/00Z$/, '59Z'); }
  const rrule = `FREQ=WEEKLY;INTERVAL=${s.every};BYDAY=${[...s.days].sort().map((d) => BYDAY[d]).join(',')};UNTIL=${until};WKST=SU`;
  return { ...base, uid: `${s.source}-${s.id}@a5-team-hub`, rrule, exdates };
}

const pad = (n: number) => String(n).padStart(2, '0');
const utc = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const compact = (s: string) => s.replace(/-/g, '');
/** 2026-10-02T18:30:00-04:00 (the browser's own offset on that date) */
function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Google Calendar (the calendar on most Android phones). */
export function googleUrl(e: CalEvent): string {
  const dates = e.allDay ? `${compact(e.startDate)}/${compact(e.endDate)}` : `${utc(e.start!)}/${utc(e.end!)}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates, details: e.details, location: e.location });
  if (e.rrule) q.set('recur', `RRULE:${e.rrule}`);
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** Outlook on the web: 'live' for Outlook.com / Hotmail, 'office' for work or school (Microsoft 365). */
export function outlookUrl(e: CalEvent, which: 'live' | 'office'): string {
  const q = new URLSearchParams({
    path: '/calendar/action/compose', rru: 'addevent', subject: e.title, body: e.details, location: e.location,
    startdt: e.allDay ? e.startDate : localIso(e.start!), enddt: e.allDay ? e.endDate : localIso(e.end!)
  });
  if (e.allDay) q.set('allday', 'true');
  return `https://outlook.${which === 'live' ? 'live' : 'office'}.com/calendar/0/action/compose?${q}`;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Lines longer than 75 octets continue on the next line after a space (RFC 5545). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  return [...out, cur].join('\r\n');
}

/** An .ics file: Apple Calendar on iPhone and Mac, and desktop Outlook. */
export function ics(e: CalEvent, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Team Hub//Team Hub//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utc(now)}`,
    ...(e.allDay
      ? [`DTSTART;VALUE=DATE:${compact(e.startDate)}`, `DTEND;VALUE=DATE:${compact(e.endDate)}`]
      : [`DTSTART:${utc(e.start!)}`, `DTEND:${utc(e.end!)}`]),
    ...(e.rrule ? [`RRULE:${e.rrule}`] : []),
    ...(e.exdates?.length ? (e.allDay
      ? [`EXDATE;VALUE=DATE:${e.exdates.map(compact).join(',')}`]
      : [`EXDATE:${e.exdates.map((d) => { const x = pd(d); x.setHours(e.start!.getHours(), e.start!.getMinutes(), 0, 0); return utc(x); }).join(',')}`]) : []),
    `SUMMARY:${esc(e.title)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.details ? [`DESCRIPTION:${esc(e.details)}`] : []),
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export const icsFileName = (e: CalEvent) => `${e.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'event'}.ics`;
