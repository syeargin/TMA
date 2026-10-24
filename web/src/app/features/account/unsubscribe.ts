import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

/**
 * /unsubscribe#t=… from an email's "Stop the weekly email" link. Works without signing in. It waits for
 * a click, so link checkers that open every link in an email don't unsubscribe anyone.
 */
export function tokenFromLink(): string {
  try {
    const m = /(?:^#|&)t=([A-Za-z0-9_\-.]+)/.exec(window.location.hash);
    return m ? m[1] : '';
  } catch { return ''; }
}

@Component({
  selector: 'th-unsubscribe',
  imports: [RouterLink, Messages],
  template: `
    <h2>Email settings</h2>
    <th-messages [error]="error()" [notice]="notice()" />
    @if (!token) {
      <p>This link is missing its code. Open it again from the email, or change what you get from <a routerLink="/account">your account page</a>.</p>
    } @else if (done(); as d) {
      @if (d.off) {
        <p>You won't get the <b>{{ d.message }}</b> from <b>{{ d.teamName }}</b> any more. Invites and notices about your account still come.</p>
        <button class="btn" type="button" (click)="act(true)" [disabled]="busy()">Undo</button>
      } @else {
        <p>You'll get the <b>{{ d.message }}</b> from <b>{{ d.teamName }}</b> again.</p>
      }
      <p class="small muted" style="margin-top:12px">Change all your team emails from <a routerLink="/account">your account page</a>.</p>
    } @else {
      <p>Stop getting this email from your team?</p>
      <button class="btn primary" type="button" (click)="act(false)" [disabled]="busy()">{{ busy() ? 'Working…' : 'Stop this email' }}</button>
      <p class="small muted" style="margin-top:12px">You can turn it back on any time from <a routerLink="/account">your account page</a>.</p>
    }`
})
export class Unsubscribe extends Page {
  private readonly api = inject(ApiService);
  readonly token = tokenFromLink();
  readonly done = signal<{ teamName: string; message: string; off: boolean } | null>(null);

  act(undo: boolean) {
    return this.run(async () => this.done.set(await this.api.unsubscribe(this.token, undo)));
  }
}
