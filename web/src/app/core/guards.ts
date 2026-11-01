import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { MeService } from './me.service';
import type { Me } from './models';

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
  return (await auth.ensureUser()) ? router.parseUrl(START_URL) : true;
};

/**
 * Where people land when they arrive (sign-in, the home-screen app, a sign-in page while already
 * signed in). Your teams with ?start=1: startGuard sends one-team families straight to that team.
 */
export const START_URL = '/teams?start=1';

/** The one team to open on arrival, or null to show Your teams (lib for startGuard; tested on its own). */
export function startTeam(me: Me): string | null {
  // Club admins and site owners start on Your teams: their club tools are there.
  if (me.platformAdmin || me.clubAdmin || (me.clubs ?? []).some((c) => c.admin)) return null;
  // Just added to a team: show the list so the new team is seen.
  if (me.acceptedInvites) return null;
  const active = me.teams.filter((t) => !t.archived);
  return active.length === 1 ? active[0].teamId : null;
}

/** Your teams, on arrival only (?start=1): one team opens that team's Home; otherwise the list, without the ?start. */
export const startGuard: CanActivateFn = async (route) => {
  if (route.queryParamMap.get('start') !== '1') return true;
  const router = inject(Router);
  let m: Me;
  try { m = await inject(MeService).load(); } catch { return router.parseUrl('/teams'); }
  const teamId = startTeam(m);
  return router.createUrlTree(teamId ? ['/teams', teamId] : ['/teams']);
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
