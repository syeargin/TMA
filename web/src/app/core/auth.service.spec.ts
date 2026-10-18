import { TestBed } from '@angular/core/testing';
import { AMPLIFY_AUTH, AuthService } from './auth.service';
import { APP_CONFIG } from './config';

const err = (name: string) => Object.assign(new Error(name), { name });

describe('auth service: one stored sign-in shared by every tab', () => {
  let amp: Record<string, ReturnType<typeof vi.fn>>;
  let auth: AuthService;

  beforeEach(() => {
    amp = {
      signIn: vi.fn(), signOut: vi.fn().mockResolvedValue(undefined),
      getCurrentUser: vi.fn(), fetchUserAttributes: vi.fn()
    };
    TestBed.configureTestingModule({ providers: [{ provide: APP_CONFIG, useValue: {} }, { provide: AMPLIFY_AUTH, useValue: amp }] });
    auth = TestBed.inject(AuthService);
  });

  const signedInAs = (email: string, sub = 'u1') => {
    amp['getCurrentUser'].mockResolvedValue({ userId: sub });
    amp['fetchUserAttributes'].mockResolvedValue({ email, sub });
  };

  it('signs in normally', async () => {
    amp['signIn'].mockResolvedValue({ nextStep: { signInStep: 'DONE' } });
    expect(await auth.logIn(' Pat@Example.com ', 'pw')).toBe('DONE');
    expect(amp['signIn']).toHaveBeenCalledWith({ username: 'pat@example.com', password: 'pw' });
  });

  it('treats "already signed in" as done when it is the same person (another tab signed in)', async () => {
    amp['signIn'].mockRejectedValue(err('UserAlreadyAuthenticatedException'));
    signedInAs('pat@example.com');
    expect(await auth.logIn('PAT@example.com', 'pw')).toBe('DONE');
    expect(amp['signOut']).not.toHaveBeenCalled();
    expect(auth.user()).toEqual({ email: 'pat@example.com', sub: 'u1' });
  });

  it('replaces a different stored sign-in on this device, then signs in', async () => {
    amp['signIn'].mockRejectedValueOnce(err('UserAlreadyAuthenticatedException')).mockResolvedValueOnce({ nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } });
    signedInAs('someone.else@example.com', 'u2');
    expect(await auth.logIn('pat@example.com', 'pw')).toBe('CONFIRM_SIGN_IN_WITH_TOTP_CODE');
    expect(amp['signOut']).toHaveBeenCalledWith();
    expect(amp['signIn']).toHaveBeenCalledTimes(2);
  });

  it('passes other sign-in errors through', async () => {
    amp['signIn'].mockRejectedValue(err('NotAuthorizedException'));
    await expect(auth.logIn('pat@example.com', 'bad')).rejects.toThrow('NotAuthorizedException');
  });

  it('remembers "signed out" only when nobody is signed in, not after a network error', async () => {
    amp['getCurrentUser'].mockRejectedValueOnce(err('NetworkError'));
    expect(await auth.ensureUser()).toBeNull();
    expect(auth.user()).toBeUndefined();
    amp['getCurrentUser'].mockRejectedValueOnce(err('UserUnAuthenticatedException'));
    expect(await auth.ensureUser()).toBeNull();
    expect(auth.user()).toBeNull();
  });

  it('checks again when another tab signs in or out', () => {
    auth.user.set(null);
    const seen = vi.fn();
    auth.changedElsewhere.subscribe(seen);
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(seen).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: 'CognitoIdentityServiceProvider.abc.LastAuthUser' }));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(auth.user()).toBeUndefined();
    window.dispatchEvent(new StorageEvent('storage', { key: null })); // localStorage.clear() elsewhere
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
