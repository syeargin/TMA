import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { MeService } from './me.service';

/** Team screens: signed-in people only. */
export const signedInGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.configured) return router.parseUrl('/unconfigured');
  return (await auth.ensureUser()) ? true : router.parseUrl('/signin');
};

/** Sign-in screens: send people who are already signed in to their teams. */
export const signedOutGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.configured) return router.parseUrl('/unconfigured');
  return (await auth.ensureUser()) ? router.parseUrl('/') : true;
};

/** Remembered at sign-up, so a new account isn't asked to accept the notice twice. */
export const PRIVACY_KEY = 'th.privacyAccepted';

/**
 * Signed-in screens: the current privacy notice must be accepted first (R4). Someone who ticked the
 * box at sign-up on this device is recorded automatically; everyone else sees /consent once per version.
 */
export const privacyGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const me = inject(MeService);
  const api = inject(ApiService);
  let m;
  try { m = await me.load(); } catch { return true; } // the page itself shows the error
  const p = m.privacy;
  if (!p || p.accepted) return true;
  let ticked = '';
  try { ticked = localStorage.getItem(PRIVACY_KEY) ?? ''; } catch { /* storage blocked */ }
  if (ticked === p.version) {
    try {
      await api.acceptPrivacy(p.version);
      me.me.update((x) => (x ? { ...x, privacy: { ...p, accepted: true } } : x));
      try { localStorage.removeItem(PRIVACY_KEY); } catch { /* fine */ }
      return true;
    } catch { /* fall through to the page */ }
  }
  return router.createUrlTree(['/consent'], { queryParams: { next: state.url } });
};
