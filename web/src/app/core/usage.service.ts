import { Injectable, Injector, inject } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { PUBLIC_AREAS, type Area, type Device, type Source } from '@shared/usage';
import { ApiService } from './api.service';
import { APP_CONFIG } from './config';

/** Which page a site URL is, for the usage counts: /teams/t/roster/attendance → "attendance". */
export function areaOf(url: string): { area: Area; teamId?: string } {
  const path = url.split(/[?#]/)[0];
  const t = /^\/teams\/([^/]+)\/?(.*)$/.exec(path);
  if (t) {
    const [, teamId, rest] = t;
    const [seg = '', id, section] = rest.split('/');
    const team = (area: Area) => ({ area, teamId: decodeURIComponent(teamId) });
    if (!seg) return team('home');
    if (seg === 'tournaments') {
      if (!id) return team('tournaments');
      return team((['matches', 'ref', 'meals', 'travel', 'agenda'] as const).find((s) => s === section) ?? 'gameday');
    }
    if (seg === 'roster') return team(id === 'attendance' ? 'attendance' : 'roster');
    return team((['schedule', 'stats', 'fund', 'info', 'members', 'communications'] as const).find((s) => s === seg) ?? 'home');
  }
  if (path === '/teams') return { area: 'teams' };
  if (path === '/') return { area: 'landing' };
  if (/^\/(account|security|consent)/.test(path)) return { area: 'account' };
  if (path.startsWith('/help')) return { area: 'help' };
  if (path.startsWith('/admin')) return { area: 'admin' };
  if (path.startsWith('/clubs')) return { area: 'club' };
  if (/^\/(signin|signup|verify|forgot|reset)/.test(path)) return { area: 'signin' };
  if (/^\/(answer|unsubscribe)/.test(path)) return { area: 'answer' };
  return { area: 'other' };
}

/** Phone, tablet or computer, from the screen and pointer (no user agent sniffing). */
export function deviceOf(w: Pick<Window, 'matchMedia' | 'screen'> = window): Device {
  const coarse = w.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (!coarse) return 'computer';
  return Math.min(w.screen.width, w.screen.height) < 600 ? 'phone' : 'tablet';
}

/** How a visit started: a Teem Hub email or text link (?via=), the home-screen app, another site, or typed in. */
export function sourceOf(url: string, referrer: string, standalone: boolean, origin: string): Source {
  const via = /[?&]via=(email|text)\b/.exec(url)?.[1] as Source | undefined;
  if (via) return via;
  if (standalone) return 'app';
  try { if (referrer && new URL(referrer).origin !== origin) return 'link'; } catch { /* not a URL */ }
  return 'direct';
}

const VISIT_KEY = 'th.visit';
const MAX_ERRORS = 5;

/**
 * Site usage counts (site admin › Usage and Health): each page opened, how long it took, how the visit
 * started, and errors in the browser. Totals only; the server never learns which pages you opened.
 */
@Injectable({ providedIn: 'root' })
export class UsageService {
  // Looked up when first needed, so pages that only report a share don't need the API set up (tests).
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly commit = inject(APP_CONFIG, { optional: true })?.commit;
  private started = 0;
  private first = true;
  private errors = 0;
  private running = false;

  start() {
    if (this.running || typeof window === 'undefined') return;
    this.running = true;
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) this.started = performance.now();
      else if (e instanceof NavigationEnd) {
        const url = e.urlAfterRedirects;
        // After the page has drawn: that's when it's open for the person.
        requestAnimationFrame(() => this.view(url));
      }
    });
    window.addEventListener('error', (e) => { if (!e.filename || e.filename.startsWith(location.origin)) this.error(); });
    window.addEventListener('unhandledrejection', () => this.error());
  }

  /** Results shared from a team (Stats or a tournament's Matches). */
  shared(teamId: string) {
    if (teamId) this.send('/usage/events', { kind: 'share', teamId });
  }

  private view(url: string) {
    const { area, teamId } = areaOf(url);
    const ms = Math.round(this.first ? performance.now() : performance.now() - this.started);
    const ev: Record<string, unknown> = { kind: 'view', area, device: deviceOf(), ms: Math.min(ms, 120_000) };
    if (teamId) ev['teamId'] = teamId;
    if (this.first) {
      this.first = false;
      if (this.newVisit()) ev['source'] = sourceOf(location.href, document.referrer, standalone(), location.origin);
      if (this.commit && /^[0-9a-f]{7,40}$/.test(this.commit)) ev['commit'] = this.commit;
    }
    this.send(isPublic(area) ? '/public/usage' : '/usage/events', ev);
  }

  private error() {
    if (this.errors++ >= MAX_ERRORS) return;
    const { area } = areaOf(this.router.url);
    this.send(isPublic(area) ? '/public/usage' : '/usage/events', { kind: 'error', area });
  }

  /** A reload in the same tab isn't a new visit. */
  private newVisit(): boolean {
    try {
      if (sessionStorage.getItem(VISIT_KEY)) return false;
      sessionStorage.setItem(VISIT_KEY, '1');
    } catch { /* storage blocked: count it */ }
    return true;
  }

  private send(path: string, ev: Record<string, unknown>) {
    try { this.injector.get(ApiService).call('POST', path, ev).catch(() => { /* counting never gets in the way */ }); } catch { /* no API here */ }
  }
}

const isPublic = (area: Area) => (PUBLIC_AREAS as readonly string[]).includes(area);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
