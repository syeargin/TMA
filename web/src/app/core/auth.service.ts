import { Injectable, inject, signal } from '@angular/core';
import { Amplify } from 'aws-amplify';
import {
  autoSignIn, confirmResetPassword, confirmSignIn, confirmSignUp, fetchAuthSession, fetchMFAPreference, fetchUserAttributes,
  getCurrentUser, resendSignUpCode, resetPassword, setUpTOTP, signIn, signOut, signUp, updateMFAPreference, verifyTOTPSetup
} from 'aws-amplify/auth';
import { APP_CONFIG } from './config';

export interface SignedInUser { email: string; sub: string }

const norm = (email: string) => String(email || '').trim().toLowerCase();

/** Email-and-password sign-in against the Cognito user pool (SRP, via Amplify). */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly cfg = inject(APP_CONFIG);
  readonly configured = !!(this.cfg.userPoolId && this.cfg.userPoolClientId);

  /** undefined = not checked yet; null = signed out. */
  readonly user = signal<SignedInUser | null | undefined>(undefined);
  /** The email typed on the last sign-in screen, carried to verify/reset. */
  readonly email = signal('');

  constructor() {
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
      await getCurrentUser();
      const attrs = await fetchUserAttributes();
      found = { email: attrs.email ?? '', sub: attrs.sub ?? '' };
    } catch {
      found = null;
    }
    this.user.set(found);
    return found;
  }

  /** The access token for API and WebSocket calls (Amplify refreshes it when needed). */
  async accessToken(forceRefresh = false): Promise<string | undefined> {
    const { tokens } = await fetchAuthSession({ forceRefresh });
    return tokens?.accessToken?.toString();
  }

  async createAccount(email: string, password: string) {
    const res = await signUp({ username: norm(email), password, options: { userAttributes: { email: norm(email) }, autoSignIn: true } });
    return res.nextStep.signUpStep;
  }

  async verifyEmail(email: string, code: string): Promise<'SIGNED_IN' | 'SIGN_IN'> {
    const res = await confirmSignUp({ username: norm(email), confirmationCode: code.trim() });
    if (res.nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') {
      try { await autoSignIn(); this.user.set(undefined); return 'SIGNED_IN'; } catch { return 'SIGN_IN'; }
    }
    return 'SIGN_IN';
  }

  resendCode(email: string) { return resendSignUpCode({ username: norm(email) }); }

  async logIn(email: string, password: string) {
    const res = await signIn({ username: norm(email), password });
    this.user.set(undefined);
    return res.nextStep.signInStep;
  }

  /** The 6-digit code from the authenticator app, when sign-in asks for it. */
  async confirmCode(code: string) {
    const res = await confirmSignIn({ challengeResponse: code.replace(/\s+/g, '') });
    this.user.set(undefined);
    return res.nextStep.signInStep;
  }

  async logOut(everywhere = false) {
    await signOut({ global: everywhere });
    this.user.set(null);
  }

  // ----- two-step sign-in with an authenticator app (R2) -----

  /** Whether this person has an authenticator app turned on. */
  async twoStepOn(): Promise<boolean> {
    const pref = await fetchMFAPreference();
    return !!pref.enabled?.includes('TOTP');
  }

  /** Starts setup: the key to scan (as an otpauth:// link) or type into the app. */
  async startTwoStep(appName: string, accountName: string): Promise<{ secret: string; uri: string }> {
    const details = await setUpTOTP();
    return { secret: details.sharedSecret, uri: details.getSetupUri(appName, accountName).toString() };
  }

  /** Confirms the app with one code and turns it on; Cognito then asks for a code at every sign-in. */
  async finishTwoStep(code: string) {
    await verifyTOTPSetup({ code: code.replace(/\s+/g, '') });
    await updateMFAPreference({ totp: 'PREFERRED' });
  }

  async turnOffTwoStep() {
    await updateMFAPreference({ totp: 'DISABLED' });
  }

  async startReset(email: string) { await resetPassword({ username: norm(email) }); }

  finishReset(email: string, code: string, newPassword: string) {
    return confirmResetPassword({ username: norm(email), confirmationCode: code.trim(), newPassword });
  }
}
