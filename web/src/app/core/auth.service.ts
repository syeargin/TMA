import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Amplify } from 'aws-amplify';
import {
  autoSignIn, confirmResetPassword, confirmSignIn, confirmSignUp, fetchAuthSession, fetchMFAPreference, fetchUserAttributes,
  getCurrentUser, resendSignUpCode, resetPassword, setUpTOTP, signIn, signOut, signUp, updateMFAPreference, verifyTOTPSetup
} from 'aws-amplify/auth';
import { Subject } from 'rxjs';
import { APP_CONFIG } from './config';

const AMPLIFY_DEFAULT = {
  autoSignIn, confirmResetPassword, confirmSignIn, confirmSignUp, fetchAuthSession, fetchMFAPreference, fetchUserAttributes,
  getCurrentUser, resendSignUpCode, resetPassword, setUpTOTP, signIn, signOut, signUp, updateMFAPreference, verifyTOTPSetup
};
/** Amplify's sign-in functions, swappable in tests. */
export const AMPLIFY_AUTH = new InjectionToken<typeof AMPLIFY_DEFAULT>('Amplify auth', { providedIn: 'root', factory: () => AMPLIFY_DEFAULT });

/** Amplify keeps the sign-in in localStorage under these keys, shared by every tab of the site. */
const TOKEN_KEY = /^CognitoIdentityServiceProvider\./;
const errName = (e: unknown) => (e as { name?: string } | null)?.name ?? '';

export interface SignedInUser { email: string; sub: string }

const norm = (email: string) => String(email || '').trim().toLowerCase();

/** Email-and-password sign-in against the Cognito user pool (SRP, via Amplify). */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly cfg = inject(APP_CONFIG);
  private readonly amp = inject(AMPLIFY_AUTH);
  readonly configured = !!(this.cfg.userPoolId && this.cfg.userPoolClientId);

  /** undefined = not checked yet; null = signed out. */
  readonly user = signal<SignedInUser | null | undefined>(undefined);
  /** Fired when another tab of the site signs in or out (the app follows along). */
  readonly changedElsewhere = new Subject<void>();
  /** The email typed on the last sign-in screen, carried to verify/reset. */
  readonly email = signal('');

  constructor() {
    // Every tab shares one stored sign-in, but each remembers whether it's signed in: when another
    // tab signs in or out, check again rather than act on the old answer.
    if (typeof window !== 'undefined') {
      const onStorage = (e: StorageEvent) => {
        if (e.key !== null && !TOKEN_KEY.test(e.key)) return;
        this.user.set(undefined);
        this.changedElsewhere.next();
      };
      window.addEventListener('storage', onStorage);
      inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', onStorage));
    }
    if (!this.configured) return;
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: this.cfg.userPoolId!,
          userPoolClientId: this.cfg.userPoolClientId!,
          loginWith: { email: true },
          signUpVerificationMethod: 'code',
          passwordFormat: { minLength: 10, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSpecialCharacters: false }
        }
      }
    });
  }

  /** The signed-in user, checking with Cognito once and then remembering. */
  async ensureUser(): Promise<SignedInUser | null> {
    const known = this.user();
    if (known !== undefined) return known;
    let found: SignedInUser | null = null;
    try {
      await this.amp.getCurrentUser();
      const attrs = await this.amp.fetchUserAttributes();
      found = { email: attrs.email ?? '', sub: attrs.sub ?? '' };
    } catch (e) {
      // Only "nobody is signed in" is remembered. Anything else (a network blip) is checked again
      // next time, so a stored sign-in isn't mistaken for none.
      if (errName(e) !== 'UserUnAuthenticatedException') return null;
    }
    this.user.set(found);
    return found;
  }

  /** The access token for API and WebSocket calls (Amplify refreshes it when needed). */
  async accessToken(forceRefresh = false): Promise<string | undefined> {
    const { tokens } = await this.amp.fetchAuthSession({ forceRefresh });
    return tokens?.accessToken?.toString();
  }

  async createAccount(email: string, password: string) {
    const res = await this.amp.signUp({ username: norm(email), password, options: { userAttributes: { email: norm(email) }, autoSignIn: true } });
    return res.nextStep.signUpStep;
  }

  async verifyEmail(email: string, code: string): Promise<'SIGNED_IN' | 'SIGN_IN'> {
    const res = await this.amp.confirmSignUp({ username: norm(email), confirmationCode: code.trim() });
    if (res.nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') {
      try { await this.amp.autoSignIn(); this.user.set(undefined); return 'SIGNED_IN'; } catch { return 'SIGN_IN'; }
    }
    return 'SIGN_IN';
  }

  resendCode(email: string) { return this.amp.resendSignUpCode({ username: norm(email) }); }

  /**
   * Signs in. If this browser already holds a sign-in (another tab signed in, or this page's check
   * was out of date), Amplify refuses with UserAlreadyAuthenticatedException: for the same person
   * that's simply done; for someone else, the old sign-in is cleared on this device and we try again.
   */
  async logIn(email: string, password: string) {
    try {
      const res = await this.amp.signIn({ username: norm(email), password });
      this.user.set(undefined);
      return res.nextStep.signInStep;
    } catch (e) {
      if (errName(e) !== 'UserAlreadyAuthenticatedException') throw e;
      this.user.set(undefined);
      const current = await this.ensureUser();
      if (current && norm(current.email) === norm(email)) return 'DONE' as const;
      await this.amp.signOut();
      this.user.set(undefined);
      const res = await this.amp.signIn({ username: norm(email), password });
      return res.nextStep.signInStep;
    }
  }

  /** The 6-digit code from the authenticator app, when sign-in asks for it. */
  async confirmCode(code: string) {
    const res = await this.amp.confirmSignIn({ challengeResponse: code.replace(/\s+/g, '') });
    this.user.set(undefined);
    return res.nextStep.signInStep;
  }

  async logOut(everywhere = false) {
    await this.amp.signOut({ global: everywhere });
    this.user.set(null);
  }

  // ----- two-step sign-in with an authenticator app (R2) -----

  /** Whether this person has an authenticator app turned on. */
  async twoStepOn(): Promise<boolean> {
    const pref = await this.amp.fetchMFAPreference();
    return !!pref.enabled?.includes('TOTP');
  }

  /** Starts setup: the key to scan (as an otpauth:// link) or type into the app. */
  async startTwoStep(appName: string, accountName: string): Promise<{ secret: string; uri: string }> {
    const details = await this.amp.setUpTOTP();
    return { secret: details.sharedSecret, uri: details.getSetupUri(appName, accountName).toString() };
  }

  /** Confirms the app with one code and turns it on; Cognito then asks for a code at every sign-in. */
  async finishTwoStep(code: string) {
    await this.amp.verifyTOTPSetup({ code: code.replace(/\s+/g, '') });
    await this.amp.updateMFAPreference({ totp: 'PREFERRED' });
  }

  async turnOffTwoStep() {
    await this.amp.updateMFAPreference({ totp: 'DISABLED' });
  }

  async startReset(email: string) { await this.amp.resetPassword({ username: norm(email) }); }

  finishReset(email: string, code: string, newPassword: string) {
    return this.amp.confirmResetPassword({ username: norm(email), confirmationCode: code.trim(), newPassword });
  }
}
