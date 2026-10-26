/**
 * When each team's calendar feed is fetched. The job runs every 10 minutes (template.yaml
 * FeedSyncFunction) and syncs only the teams that are due:
 *
 * - every 30 minutes on days the team has something today or tomorrow (when changes matter most),
 * - every 2 hours otherwise,
 * - never between 11 PM and 5 AM in the team's time zone.
 *
 * Each team has its own slot inside the interval (from its id), so a club's teams don't all hit the
 * club's calendar site at the same minute. Sync now, imports and catch-ups don't wait for a slot.
 */
import { createHash } from "node:crypto";
import { localParts } from "../comms/zoned.js";

export const TICK_MIN = 10;
export const BUSY_MIN = 30;
export const QUIET_MIN = 120;
/** Local hours with no syncing: from 23:00 up to 05:00. */
export const NIGHT = { from: 23, to: 5 };

const addDay = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** 0–11: which 10-minute slot of a 2-hour cycle is this team's. */
export function slotOf(teamId: string): number {
  return createHash("sha1").update(teamId).digest()[0] % (QUIET_MIN / TICK_MIN);
}

/** Days with feed events coming up, kept on the feed after each sync so the job needn't read the events. */
export function soonDates(events: { date: string; endDate?: string; cancelled?: boolean }[], today: string, days = 14): string[] {
  const last = addDay(today, days);
  const out = new Set<string>();
  for (const e of events) {
    if (e.cancelled) continue;
    for (let d = e.date < today ? today : e.date; d <= (e.endDate || e.date) && d <= last; d = addDay(d, 1)) out.add(d);
  }
  return [...out].sort();
}

export type DueInput = { teamId: string; at: Date; zone: string; soon: string[]; lastAttemptAt?: string };

/** Minutes between syncs right now: 30 with something today or tomorrow, 120 otherwise. */
export function intervalAt(i: DueInput): number {
  const today = localParts(i.at, i.zone).date;
  return i.soon.includes(today) || i.soon.includes(addDay(today, 1)) ? BUSY_MIN : QUIET_MIN;
}

export const isNight = (at: Date, zone: string) => {
  const h = Number(localParts(at, zone).hhmm.slice(0, 2));
  return h >= NIGHT.from || h < NIGHT.to;
};

/** Should the job sync this team on the run at `at`? */
export function isDue(i: DueInput): boolean {
  if (isNight(i.at, i.zone)) return false;
  const interval = intervalAt(i);
  const since = i.lastAttemptAt ? (i.at.getTime() - Date.parse(i.lastAttemptAt)) / 60000 : Infinity;
  // Just synced (Sync now, or the last slot): not again yet.
  if (since < interval / 2) return false;
  // A missed slot (the night, or a job run that didn't happen): catch up straight away.
  if (since >= interval * 2) return true;
  const tick = Math.floor(i.at.getTime() / 60000 / TICK_MIN);
  return (tick + slotOf(i.teamId)) % (interval / TICK_MIN) === 0;
}

/** When the job will next sync this team (for "Next sync around 7:40 AM"), looking up to two days ahead. */
export function nextDue(i: DueInput): Date | null {
  const start = Math.ceil(i.at.getTime() / 60000 / TICK_MIN) * TICK_MIN * 60000;
  for (let t = start; t < i.at.getTime() + 2 * 86400000; t += TICK_MIN * 60000) {
    const at = new Date(t);
    if (isDue({ ...i, at })) return at;
  }
  return null;
}
