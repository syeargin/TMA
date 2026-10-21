import { Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { MeService } from '../../core/me.service';
import { Autofocus } from '../../shared/autofocus';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

type Mode = 'loading' | 'off' | 'on' | 'setup';

/** The secret in groups of four, easier to type into an app by hand. */
export const groupKey = (s: string) => s.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/** /security — turn two-step sign-in (an authenticator app) on or off (R2). */
@Component({
  selector: 'th-two-step',
  imports: [ReactiveFormsModule, RouterLink, Messages, Autofocus],
  template: `
    <h2>Two-step sign-in</h2>
    <th-messages [error]="error()" [notice]="notice()" />
    @switch (mode()) {
      @case ('loading') { <p class="muted">Checking…</p> }
      @case ('on') {
        <p><span class="pill p-ok">On</span> You enter a code from your authenticator app each time you sign in.</p>
        <p class="small muted">New phone? Set it up again: the old phone's codes stop working once the new one is confirmed.</p>
        <div class="row" style="margin-top:12px">
          <button class="btn" type="button" (click)="start()" [disabled]="busy()">Use a new phone</button>
          <button class="btn" type="button" [class.danger]="!confirmOff()" [class.confirming]="confirmOff()" (click)="turnOff()" [disabled]="busy()">
            {{ confirmOff() ? 'Tap again to turn off' : 'Turn off' }}
          </button>
        </div>
        @if (confirmOff() && required()) {
          <p class="small muted" style="margin-top:8px">Your {{ what() }} tools stop working while it's off.</p>
        }
      }
      @case ('off') {
        <p>Sign in with your password <b>and</b> a 6-digit code from an app on your phone, so a stolen password isn't enough to get in.</p>
        @if (required()) {
          <p class="small"><b>Needed for your {{ what() }} tools.</b> They stay locked until it's on.</p>
        } @else {
          <p class="small muted">Optional for families, coaches and coordinators.</p>
        }
        <p class="small muted">Any authenticator app works, such as Google Authenticator, Microsoft Authenticator, 1Password or Authy. Text messages aren't used.</p>
        <button class="btn primary" type="button" (click)="start()" [disabled]="busy()" style="margin-top:12px">{{ busy() ? 'Working…' : 'Set it up' }}</button>
      }
      @case ('setup') {
        <ol class="steps">
          <li>Open your authenticator app and add an account.</li>
          <li>Scan this code with it.
            @if (qr()) { <img class="qr" [src]="qr()" width="200" height="200" alt="QR code to add Teem Hub to your authenticator app"> }
            <span class="small muted">Can't scan? Choose "enter a setup key" (time-based) and type:</span>
            <code class="key" aria-label="Setup key">{{ key() }}</code>
            <a class="small" [href]="uri()">On this phone? Open it in your app</a>
          </li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <form [formGroup]="form" (ngSubmit)="finish()" novalidate>
          <label for="code">Code from the app<input id="code" formControlName="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required thAutofocus></label>
          <div class="row">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Turn on' }}</button>
            <button class="btn ghost" type="button" (click)="cancel()">Cancel</button>
          </div>
        </form>
        <p class="small muted" style="margin-top:10px">Once it's on you'll be signed out everywhere, then sign in again with your password and a code.</p>
      }
    }
    <div class="links"><a class="link" routerLink="/teams">Back to your teams</a></div>`
})
export class TwoStep extends Page {
  private readonly auth = inject(AuthService);
  private readonly meSvc = inject(MeService);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly mode = signal<Mode>('loading');
  private wasOn = false;
  readonly qr = signal('');
  readonly uri = signal('');
  readonly key = signal('');
  readonly confirmOff = signal(false);
  readonly form = this.fb.group({ code: '' });

  readonly required = computed(() => !!this.meSvc.me()?.mfa?.required);
  readonly what = computed(() => (this.meSvc.me()?.platformAdmin ? 'site owner' : 'club admin'));

  constructor() {
    super();
    void this.meSvc.load().catch(() => undefined);
    void this.refresh();
  }

  private async refresh() {
    try {
      this.wasOn = await this.auth.twoStepOn();
      this.mode.set(this.wasOn ? 'on' : 'off');
    } catch (err) {
      this.mode.set('off');
      this.error.set((err as Error).message);
    }
  }

  start() {
    this.confirmOff.set(false);
    return this.run(async () => {
      const email = (await this.auth.ensureUser())?.email ?? '';
      const { secret, uri } = await this.auth.startTwoStep('Teem Hub', email);
      this.key.set(groupKey(secret));
      this.uri.set(uri);
      // qrcode is CommonJS: its functions arrive under default.
      const mod = await import('qrcode');
      const QR = (mod as unknown as { default?: typeof mod }).default ?? mod;
      this.qr.set(await QR.toDataURL(uri, { margin: 1, width: 400, errorCorrectionLevel: 'M' }));
      this.form.reset({ code: '' });
      this.mode.set('setup');
    });
  }

  cancel() { this.mode.set(this.wasOn ? 'on' : 'off'); this.error.set(''); }

  finish() {
    const code = this.form.getRawValue().code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) { this.error.set('Enter the 6-digit code from your authenticator app.'); return; }
    return this.run(async () => {
      try {
        await this.auth.finishTwoStep(code);
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === 'EnableSoftwareTokenMFAException' || name === 'CodeMismatchException') {
          throw new Error("That code isn't right. Enter the code your app shows now; it changes every 30 seconds.");
        }
        throw err;
      }
      // Sign out everywhere, so every session from now on was opened with a code.
      await this.auth.logOut(true);
      this.meSvc.me.set(null);
      await this.go('/signin', { notice: 'Two-step sign-in is on. Sign in again with your password and a code from your app.' });
    });
  }

  turnOff() {
    if (!this.confirmOff()) { this.confirmOff.set(true); return; }
    return this.run(async () => {
      await this.auth.turnOffTwoStep();
      this.confirmOff.set(false);
      this.wasOn = false;
      this.mode.set('off');
      this.notice.set('Two-step sign-in is off.');
      await this.meSvc.load(true).catch(() => undefined);
    });
  }
}
