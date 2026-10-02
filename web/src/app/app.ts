import { Component, effect, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { APP_CONFIG } from './core/config';
import { HeaderService } from './core/header.service';
import { LiveService } from './core/live.service';
import { MeService } from './core/me.service';
import { ThemeService } from './core/theme.service';
import type { LiveStatus } from './core/live-client';
import { ToastService } from './core/toast.service';

@Component({
  selector: 'th-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header class="hdr">
      <div class="hdr-in">
        <a class="brand" routerLink="/">
          <svg class="crest" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M26 2c-6 8-8 16-7 24s5 16 13 24M4.5 17c9 2 18 1 26-4s13-10 15-11M3 31c9-4 20-4 29 0s14 11 16 12" fill="none" stroke="#fff" stroke-width="2" opacity=".85"/><circle cx="26" cy="26" r="24" fill="none" class="crest-a" stroke-width="2.5" stroke-dasharray="10 140" transform="rotate(-60 26 26)"/></svg>
          <div><h1>{{ header.title() }}</h1><div class="sub">{{ header.sub() || theme.look()?.name || '' }}</div></div>
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
          @if (auth.user(); as u) {
            <a class="who" routerLink="/" [title]="'Signed in as ' + u.email">
              <span><span class="w-l">Signed in</span><span class="w-n">{{ me.label() || u.email }}</span></span>
              <span class="w-c">Your teams</span>
            </a>
          }
        </div>
      </div>
    </header>
    <router-outlet />
    @if (toast.message()) { <div class="toast" [class.bad]="toast.bad()" role="status" aria-live="polite">{{ toast.message() }}</div> }
    <footer class="foot muted">@if (commit) { Build {{ commit }} }</footer>`
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
  constructor() {
    // Load the name for the header once someone is signed in.
    effect(() => { if (this.auth.user()) void this.me.load().catch(() => {}); else this.me.clear(); });
  }
  readonly liveText: Record<LiveStatus, string> = { off: '', live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…' };
}
