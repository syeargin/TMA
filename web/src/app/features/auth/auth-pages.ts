import { Component, inject } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { PASSWORD_RULES } from '../../core/errors';
import { Autofocus } from '../../shared/autofocus';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

const IMPORTS = [ReactiveFormsModule, RouterLink, Messages, Autofocus];

abstract class AuthPage extends Page {
  protected readonly auth = inject(AuthService);
  protected readonly fb = inject(NonNullableFormBuilder);
  readonly rules = PASSWORD_RULES;
  get email() { return this.auth.email(); }
  protected remember(email: string) { this.auth.email.set(String(email).trim()); }
}

@Component({
  selector: 'th-signin',
  imports: IMPORTS,
  template: `
    <h2>Sign in</h2>
    <th-messages [error]="error()" [notice]="notice()" />
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <label for="email">Email<input id="email" type="email" formControlName="email" autocomplete="email" required thAutofocus></label>
      <label for="password">Password<input id="password" type="password" formControlName="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Working…' : 'Sign in' }}</button>
    </form>
    <div class="links">
      <a class="link" routerLink="/forgot">Forgot password?</a>
      <span>New here? <a class="link" routerLink="/signup">Create your account</a></span>
    </div>`
})
export class SignIn extends AuthPage {
  readonly form = this.fb.group({ email: this.auth.email(), password: '' });
  submit() {
    const { email, password } = this.form.getRawValue();
    this.remember(email);
    return this.run(async () => {
      const step = await this.auth.logIn(email, password);
      if (step === 'DONE') return this.go('/');
      if (step === 'CONFIRM_SIGN_UP') {
        await this.auth.resendCode(email);
        return this.go('/verify', { notice: "Verify your email first. We've sent you a new code." });
      }
      if (step === 'RESET_PASSWORD') { await this.auth.startReset(email); return this.go('/reset'); }
      this.error.set("Sign-in needs a step this page doesn't support yet.");
      return;
    });
  }
}

@Component({
  selector: 'th-signup',
  imports: IMPORTS,
  template: `
    <h2>Create your account</h2>
    <p class="muted">Use the email address your coach or team coordinator invited.</p>
    <th-messages [error]="error()" [notice]="notice()" />
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <label for="email">Email<input id="email" type="email" formControlName="email" autocomplete="email" required thAutofocus></label>
      <label for="password">Password<input id="password" type="password" formControlName="password" autocomplete="new-password" required minlength="10" aria-describedby="pw-rules"></label>
      <p class="hint" id="pw-rules">{{ rules }}</p>
      <label for="confirm">Confirm password<input id="confirm" type="password" formControlName="confirm" autocomplete="new-password" required></label>
      <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Working…' : 'Create account' }}</button>
    </form>
    <div class="links"><span>Already have an account? <a class="link" routerLink="/signin">Sign in</a></span></div>`
})
export class SignUp extends AuthPage {
  readonly form = this.fb.group({ email: this.auth.email(), password: '', confirm: '' });
  submit() {
    const { email, password, confirm } = this.form.getRawValue();
    this.remember(email);
    if (password !== confirm) { this.error.set("The passwords don't match."); return; }
    return this.run(async () => {
      const step = await this.auth.createAccount(email, password);
      return step === 'CONFIRM_SIGN_UP' ? this.go('/verify') : this.go('/');
    });
  }
}

@Component({
  selector: 'th-verify',
  imports: IMPORTS,
  template: `
    <h2>Check your email</h2>
    <p class="muted">We sent a 6-digit code to <b>{{ email }}</b>. It can take a minute to arrive; check spam if you don't see it.</p>
    <th-messages [error]="error()" [notice]="notice()" />
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <label for="code">Verification code<input id="code" type="text" formControlName="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required thAutofocus></label>
      <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Working…' : 'Verify email' }}</button>
    </form>
    <div class="links">
      <button class="link" type="button" (click)="resend()">Send a new code</button>
      <a class="link" routerLink="/signin">Back to sign in</a>
    </div>`
})
export class Verify extends AuthPage {
  readonly form = this.fb.group({ code: '' });
  submit() {
    return this.run(async () => {
      const next = await this.auth.verifyEmail(this.email, this.form.getRawValue().code);
      if (next === 'SIGNED_IN') return this.go('/', { notice: 'Email verified. Welcome to the Team Hub.' });
      return this.go('/signin', { notice: 'Email verified. Sign in to continue.' });
    });
  }
  resend() {
    return this.run(async () => {
      await this.auth.resendCode(this.email);
      this.notice.set('A new code is on its way.');
    });
  }
}

@Component({
  selector: 'th-forgot',
  imports: IMPORTS,
  template: `
    <h2>Reset your password</h2>
    <p class="muted">We'll email you a code to set a new password.</p>
    <th-messages [error]="error()" [notice]="notice()" />
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <label for="email">Email<input id="email" type="email" formControlName="email" autocomplete="email" required thAutofocus></label>
      <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Working…' : 'Send code' }}</button>
    </form>
    <div class="links"><a class="link" routerLink="/signin">Back to sign in</a></div>`
})
export class Forgot extends AuthPage {
  readonly form = this.fb.group({ email: this.auth.email() });
  submit() {
    const { email } = this.form.getRawValue();
    this.remember(email);
    return this.run(async () => {
      await this.auth.startReset(email);
      return this.go('/reset', { notice: 'If that email has an account, a code is on its way.' });
    });
  }
}

@Component({
  selector: 'th-reset',
  imports: IMPORTS,
  template: `
    <h2>Set a new password</h2>
    <p class="muted">Enter the code we sent to <b>{{ email }}</b> and choose a new password.</p>
    <th-messages [error]="error()" [notice]="notice()" />
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <label for="code">Code<input id="code" type="text" formControlName="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required thAutofocus></label>
      <label for="password">New password<input id="password" type="password" formControlName="password" autocomplete="new-password" required minlength="10" aria-describedby="pw-rules"></label>
      <p class="hint" id="pw-rules">{{ rules }}</p>
      <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Working…' : 'Save new password' }}</button>
    </form>
    <div class="links"><a class="link" routerLink="/forgot">Send a new code</a></div>`
})
export class Reset extends AuthPage {
  readonly form = this.fb.group({ code: '', password: '' });
  submit() {
    const { code, password } = this.form.getRawValue();
    return this.run(async () => {
      await this.auth.finishReset(this.email, code, password);
      return this.go('/signin', { notice: 'Password updated. Sign in with your new password.' });
    });
  }
}

@Component({
  selector: 'th-unconfigured',
  template: `
    <h2>Sign-in isn't set up here</h2>
    <p class="muted">This copy of the site has no sign-in settings. Use the deployed dev or prod address.</p>`
})
export class Unconfigured {}
