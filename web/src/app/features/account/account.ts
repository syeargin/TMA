import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { MeService } from '../../core/me.service';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

/** /account — two-step sign-in, privacy, download my data, delete my account (R2, R4). */
@Component({
  selector: 'th-account',
  imports: [RouterLink, Messages],
  template: `
    <h2>Your account</h2>
    <th-messages [error]="error()" [notice]="notice()" />
    <p class="muted small">Signed in as <b>{{ email() }}</b></p>

    <section class="acct">
      <h3>Two-step sign-in</h3>
      <p class="small">A code from an authenticator app at each sign-in, as well as your password.@if (me()?.mfa?.required) { Needed for your club admin tools. }</p>
      <a class="btn sm" routerLink="/security">Two-step sign-in settings</a>
    </section>

    <section class="acct">
      <h3>Your data</h3>
      <p class="small">Download a file with everything Team Hub keeps about you and your family: your account, teams and roles, your player's details, availability, travel, sizes and your fund entries.</p>
      <button class="btn sm" type="button" (click)="download()" [disabled]="busy()">Download my data</button>
      <p class="small muted" style="margin-top:8px">To correct or remove your player's details, ask your team coordinator. See the <a routerLink="/privacy">privacy notice</a>@if (me()?.privacy?.acceptedAt) {, which you accepted {{ acceptedOn() }}}.</p>
    </section>

    <section class="acct danger-zone">
      <h3>Delete my account</h3>
      <p class="small">Removes your sign-in, your team memberships and invites, and your own phone and email on your player's roster entry, right away. Your player's record and the team's fund entries belong to the team and stay; your team coordinator can remove them.</p>
      <p class="small muted">The last admin of a team or club, or a site owner, needs to hand that over first.</p>
      <label for="delConfirm">Type DELETE to confirm<input id="delConfirm" autocomplete="off" spellcheck="false" [value]="confirmText()" (input)="confirmText.set($any($event.target).value)"></label>
      <button class="btn sm danger solid" type="button" style="margin-top:8px" [disabled]="busy() || confirmText().trim().toUpperCase() !== 'DELETE'" (click)="deleteAccount()">{{ busy() ? 'Deleting…' : 'Delete my account' }}</button>
    </section>

    <div class="links"><a class="link" routerLink="/">Back to your teams</a></div>`
})
export class Account extends Page {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly meSvc = inject(MeService);
  readonly me = this.meSvc.me;
  readonly email = computed(() => this.me()?.email ?? this.auth.user()?.email ?? '');
  readonly confirmText = signal('');
  readonly acceptedOn = computed(() => {
    const at = this.me()?.privacy?.acceptedAt;
    return at ? new Date(at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  });

  constructor() {
    super();
    void this.meSvc.load().catch(() => undefined);
  }

  download() {
    return this.run(async () => {
      const data = await this.api.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `team-hub-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.notice.set('Your data is downloading.');
    });
  }

  deleteAccount() {
    return this.run(async () => {
      await this.api.deleteMyAccount(this.confirmText().trim());
      // The sign-in no longer exists; clear this device too.
      await this.auth.logOut().catch(() => undefined);
      this.meSvc.me.set(null);
      await this.go('/signin', { notice: 'Your account is deleted. Thank you for using Team Hub.' });
    });
  }
}
