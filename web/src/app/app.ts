import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { APP_CONFIG } from './core/config';
import { LiveService } from './core/live.service';
import type { LiveStatus } from './core/live-client';

@Component({
  selector: 'th-root',
  imports: [RouterOutlet],
  template: `
    <header class="top">
      <div><p class="eyebrow">A5 Volleyball</p><h1>Team Hub</h1></div>
      <div class="badges">
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
      </div>
    </header>
    <main class="card"><router-outlet /></main>
    <footer class="foot muted">@if (commit) { Build {{ commit }} }</footer>`
})
export class App {
  private readonly cfg = inject(APP_CONFIG);
  readonly live = inject(LiveService);
  readonly env = this.cfg.env || 'local';
  readonly commit = this.cfg.commit?.slice(0, 7);
  readonly liveText: Record<LiveStatus, string> = { off: '', live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…' };
}
