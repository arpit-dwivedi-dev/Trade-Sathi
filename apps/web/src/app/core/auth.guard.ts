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
export const authGuard: CanActivateFn = async () => {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return true;
  }

  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.whenRestored();

  return auth.session() ? true : router.createUrlTree(['/login']);
};
