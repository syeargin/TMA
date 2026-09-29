import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

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
