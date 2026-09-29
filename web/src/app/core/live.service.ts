import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { APP_CONFIG } from './config';
import { LiveClient, LiveStatus } from './live-client';

export interface TeamChange { teamId: string; collections: string[] }

/** The app's one live-update connection. Team screens watch a team; the header shows the status. */
@Injectable({ providedIn: 'root' })
export class LiveService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly url = inject(APP_CONFIG).wsUrl;

  readonly status = signal<LiveStatus>('off');
  /** A change arrived while someone was mid-edit; the header offers to show it. */
  readonly held = signal(false);
  readonly changes = new Subject<TeamChange>();
  readonly denied = new Subject<string>();
  /** The person asked to see held changes now. */
  readonly showHeld = new Subject<void>();

  private readonly client = this.url && typeof WebSocket !== 'undefined'
    ? new LiveClient({
        url: this.url,
        getToken: (force) => this.auth.accessToken(force),
        onChange: (teamId, collections) => this.changes.next({ teamId, collections }),
        onStatus: (s) => this.status.set(s),
        onDenied: (teamId) => this.denied.next(teamId)
      })
    : null;

  get enabled() { return !!this.client; }
  watch(teamId: string) { this.client?.watch(teamId); }
  stop() { this.held.set(false); this.client?.stop(); }
  ngOnDestroy() { this.client?.dispose(); }
}
