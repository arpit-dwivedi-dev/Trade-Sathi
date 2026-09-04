import { isPlatformServer } from '@angular/common';
import { PLATFORM_ID, inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';

/**
 * Guards routes that require a signed-in user.
 *
 * On the server this always allows the route through. SSR has no access to the
 * browser's session storage, so "no session visible here" says nothing about
 * whether the user is signed in — redirecting on it would bounce a genuinely
 * logged-in user to /login on every reload. The server renders a generic,
 * non-sensitive shell and the real check happens in the browser.
 *
 * In the browser the decision waits for Supabase's asynchronous session
 * restoration to finish. Reading the session signal synchronously would see a
 * transient null and redirect milliseconds before the real session resolves.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return true;
  }

  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.whenRestored();
  if (auth.session()) return true;

  // The attempted URL rides along so signing in returns the user to where they
  // were headed. Without it, following a link to a specific shell tab while
  // signed out always landed on the default tab afterwards, silently
  // discarding the destination.
  return router.createUrlTree(['/login'], {
    queryParams: { returnUrl: state.url },
  });
};

/**
 * The mirror of authGuard, for the routes that only make sense signed OUT.
 *
 * A signed-in user opening /login (a bookmark, the browser's back button after
 * signing in) was shown the sign-in form again, with no indication they already
 * had a session — and signing in a second time simply re-established the one
 * they had. Server-side this allows the route through for the same reason
 * authGuard does: SSR cannot see the session either way.
 */
export const guestGuard: CanActivateFn = async () => {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return true;
  }

  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.whenRestored();

  return auth.session() ? router.createUrlTree(['/app']) : true;
};
