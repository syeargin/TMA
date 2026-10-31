import { Component, computed, effect, inject } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { APP_CONFIG } from './core/config';
import { HeaderService } from './core/header.service';
import { LiveService } from './core/live.service';
import { MeService } from './core/me.service';
import { ThemeService } from './core/theme.service';
import type { LiveStatus } from './core/live-client';
import { ToastService } from './core/toast.service';
import { UsageService } from './core/usage.service';

/** Pages for signed-out people (a signed-in visitor goes to their teams). */
const SIGNED_OUT_PAGES = new Set(['/signin', '/signup', '/verify', '/forgot', '/reset']);
/** Pages anyone can see. */
const PUBLIC_PAGES = new Set(['/', '/privacy', '/unconfigured', '/help']);
const isPublic = (path: string) => PUBLIC_PAGES.has(path) || path.startsWith('/help/');

@Component({
  selector: 'th-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    @if (!landing()) {
    <header class="hdr">
      <div class="hdr-in">
        <a class="brand" [routerLink]="auth.user() ? '/teams' : '/'" [attr.aria-label]="sitePage() ? 'Teem Hub' : null">
          @if (sitePage()) {
            <img class="brand-logo" src="/brand/logo-white.svg" alt="Teem Hub" width="157" height="55">
          } @else {
            <!-- A team or club page: the Teem Hub mark, then the team's own name. -->
            <img class="brand-mark" src="/brand/mark-white.svg" alt="Teem Hub" width="84" height="48">
            <span class="brand-rule" aria-hidden="true"></span>
            <div><h1>{{ header.title() }}</h1><div class="sub">{{ header.sub() || theme.look()?.name || '' }}</div></div>
          }
        </a>
        <div class="hdr-side">
          @if (live.status() !== 'off') {
            <span class="live" [class.live-on]="live.status() === 'live'" [class.live-wait]="live.status() !== 'live'"
                  role="status" title="Changes others make appear here automatically">
              @if (live.held()) {
                <button class="link" type="button" (click)="live.showHeld.next()">New changes · Show</button>
              } @else {
                {{ liveText[live.status()] }}
              }
            </span>
          }
          @if (env !== 'prod') { <span class="env">{{ env }}</span> }
          <a class="hdr-help" routerLink="/help" title="Help and how-to">Help</a>
          @if (auth.user(); as u) {
            <a class="who" routerLink="/teams" [title]="'Signed in as ' + u.email">
              <span><span class="w-l">Signed in</span><span class="w-n">{{ me.label() || u.email }}</span></span>
              <span class="w-c">Your teams</span>
            </a>
          }
        </div>
      </div>
    </header>
    }
    <router-outlet />
    @if (toast.message()) { <div class="toast" [class.bad]="toast.bad()" role="status" aria-live="polite">{{ toast.message() }}</div> }
    @if (!landing()) {
      <footer class="foot muted">
        <a routerLink="/" class="foot-logo" aria-label="Teem Hub"><img class="on-light" src="/brand/logo-color.svg" alt="" width="86" height="30"><img class="on-dark" src="/brand/logo-white.svg" alt="" width="86" height="30"></a>
        <span class="foot-links"><a routerLink="/help">Help</a> · <a routerLink="/privacy">Privacy</a> · <a routerLink="/terms">Terms</a></span>
        <span class="spacer"></span>
        <span>© Teem Hub Inc.@if (commit) { · Build {{ commit }} }</span>
      </footer>
    }`
})
export class App {
  private readonly cfg = inject(APP_CONFIG);
  readonly auth = inject(AuthService);
  readonly header = inject(HeaderService);
  readonly live = inject(LiveService);
  readonly toast = inject(ToastService);
  readonly me = inject(MeService);
  readonly theme = inject(ThemeService);
  readonly env = this.cfg.env || 'local';
  readonly commit = this.cfg.commit?.slice(0, 7);
  private readonly router = inject(Router);
  /** The landing page brings its own navigation and footer. */
  readonly landing = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url.split(/[?#]/)[0] === '/')), { initialValue: location.pathname === '/' });
  constructor() {
    // Site usage counts (site admin › Usage): page opens and errors, totals only.
    inject(UsageService).start();
    // Load the name for the header once someone is signed in.
    effect(() => { if (this.auth.user()) void this.me.load().catch(() => {}); else this.me.clear(); });
    // Another tab signed in, out, or as someone else: follow it, so this tab never acts on an old answer.
    this.auth.changedElsewhere.pipe(takeUntilDestroyed()).subscribe(() => void this.followOtherTab());
  }

  private lastSub = '';
  private async followOtherTab() {
    const before = this.lastSub || this.me.me()?.sub || '';
    this.me.clear();
    const user = await this.auth.ensureUser();
    this.lastSub = user?.sub ?? '';
    const path = this.router.url.split(/[?#]/)[0];
    if (user && SIGNED_OUT_PAGES.has(path)) { await this.router.navigateByUrl('/teams'); return; }
    if (!user && !isPublic(path) && !SIGNED_OUT_PAGES.has(path)) { await this.router.navigateByUrl('/signin'); return; }
    // Signed in as someone else: start them on their own teams.
    if (user && before && before !== user.sub && !isPublic(path)) await this.router.navigateByUrl('/teams');
  }
  /** Pages that aren't a team's or club's (no title set): the full logo instead of a name. */
  readonly sitePage = computed(() => this.header.title() === 'Teem Hub' && !this.header.sub());
  readonly liveText: Record<LiveStatus, string> = { off: '', live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…' };
}
