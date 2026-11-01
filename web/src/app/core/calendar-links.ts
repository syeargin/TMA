import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { APP_CONFIG } from './config';
import type { ScheduleItem } from './schedule';

/**
 * Calendar links: a private link a calendar app checks on its own, so the schedule stays up to date
 * there (api: routes/calendars.ts). One per team, plus one for all of a person's teams.
 * The link is private: it is never logged or shown in full.
 */
export type CalType = 'practice' | 'tournament' | 'event';
export const CAL_TYPES: CalType[] = ['practice', 'tournament', 'event'];
export const TYPE_LABEL: Record<CalType, string> = { practice: 'Practices', tournament: 'Tournaments', event: 'Team events' };
export type CalApp = 'apple' | 'google' | 'outlook' | 'office' | 'copy' | 'download';
export const APP_LABEL: Record<CalApp, string> = {
  apple: 'Apple Calendar', google: 'Google Calendar', outlook: 'Outlook.com', office: 'Outlook (work or school)', copy: 'Link copied', download: 'One-time download'
};

export interface CalLink {
  scope: 'team' | 'all';
  teamId?: string;
  types?: CalType[];
  teams?: Record<string, CalType[]>;
  app: CalApp | null;
  token: string;
  createdAt: string;
  updatedAt: string;
  lastFetchAt: string | null;
}

export const typeOf = (kind: string): CalType => (kind === 'practice' ? 'practice' : kind === 'tournament' ? 'tournament' : 'event');

/** How many dates from today on each kind of event has (cancelled ones left out). */
export function countByType(items: ScheduleItem[], from: string): Record<CalType, number> {
  const out: Record<CalType, number> = { practice: 0, tournament: 0, event: 0 };
  for (const it of items) if (!it.cancelled && it.end >= from) out[typeOf(it.kind)]++;
  return out;
}

/** The app links for one calendar link (https, plus webcal for Apple, and each web calendar's "add from web" page). */
export function appUrls(feed: string, name: string) {
  const webcal = feed.replace(/^https?:\/\//, 'webcal://');
  const e = encodeURIComponent;
  return {
    feed,
    apple: webcal,
    google: `https://calendar.google.com/calendar/r?cid=${e(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${e(feed)}&name=${e(name)}`,
    office: `https://outlook.office.com/calendar/0/addfromweb?url=${e(feed)}&name=${e(name)}`
  };
}

/** "Last checked 40 minutes ago", and whether it looks like the calendar app stopped checking. */
export function lastChecked(at: string | null, now = Date.now()): { text: string; stale: boolean } {
  if (!at) return { text: 'Not checked yet. If you added it a while ago, add it again.', stale: true };
  const mins = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  const stale = mins > 14 * 24 * 60;
  const ago = mins < 2 ? 'just now' : mins < 60 ? `${mins} minutes ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'} ago` : `${Math.round(mins / 1440)} days ago`;
  return { text: stale ? `Not checked in ${Math.round(mins / 1440 / 7)} weeks. If you removed it from your calendar, stop it here too.` : `Last checked ${ago}`, stale };
}

/** The person's calendar links, shared by the subscribe panel and Your teams. */
@Injectable({ providedIn: 'root' })
export class CalendarLinks {
  private readonly api = inject(ApiService);
  private readonly base = String(inject(APP_CONFIG).apiUrl ?? '').replace(/\/$/, '');
  readonly links = signal<CalLink[] | null>(null);
  private loading: Promise<CalLink[]> | null = null;

  feedUrl(l: Pick<CalLink, 'token'>) { return `${this.base}/public/calendar.ics?k=${encodeURIComponent(l.token)}`; }
  find(scope: 'team' | 'all', teamId?: string) { return this.links()?.find((l) => l.scope === scope && (scope === 'all' || l.teamId === teamId)) ?? null; }

  load(force = false): Promise<CalLink[]> {
    if (this.links() && !force) return Promise.resolve(this.links()!);
    this.loading ??= this.api.call<{ links: CalLink[] }>('GET', '/me/calendars')
      .then((r) => { this.links.set(r.links); return r.links; })
      .finally(() => (this.loading = null));
    return this.loading;
  }

  private path(scope: 'team' | 'all', teamId?: string) { return scope === 'all' ? '/me/calendars/all' : `/me/calendars/teams/${encodeURIComponent(teamId!)}`; }
  private keep(l: CalLink) {
    const rest = (this.links() ?? []).filter((x) => !(x.scope === l.scope && x.teamId === l.teamId));
    this.links.set([...rest, l]);
    return l;
  }

  /** Make the link, or change what it includes (the link stays the same). */
  async saveTeam(teamId: string, types: CalType[], app?: CalApp) { return this.keep(await this.api.call<CalLink>('PUT', this.path('team', teamId), { types, ...(app ? { app } : {}) })); }
  async saveAll(teams: Record<string, CalType[]>, app?: CalApp) { return this.keep(await this.api.call<CalLink>('PUT', this.path('all'), { teams, ...(app ? { app } : {}) })); }
  async reset(l: CalLink) { return this.keep(await this.api.call<CalLink>('POST', `${this.path(l.scope, l.teamId)}/reset`)); }
  async stop(l: CalLink) {
    await this.api.call('DELETE', this.path(l.scope, l.teamId));
    this.links.set((this.links() ?? []).filter((x) => x !== l));
  }

  /** The calendar as a file, once: it won't update. */
  async download(l: CalLink, name: string) {
    const res = await fetch(this.feedUrl(l));
    if (!res.ok) throw new Error("The calendar didn't download. Try again.");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'schedule'}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Open an app's link once the calendar link exists. Web calendars open in a tab opened at the tap, so it isn't blocked. */
export async function openApp(app: Exclude<CalApp, 'copy' | 'download'>, make: () => Promise<{ feed: string; name: string }>) {
  const tab = app === 'apple' ? null : window.open('', '_blank');
  try {
    const { feed, name } = await make();
    const url = appUrls(feed, name)[app];
    if (tab) { tab.opener = null; tab.location.href = url; } else location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
