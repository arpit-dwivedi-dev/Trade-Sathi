import { isPlatformServer } from '@angular/common';
import { PLATFORM_ID, inject } from '@angular/core';
import { CanActivateFn, RedirectCommand, Router } from '@angular/router';

import { AdminAccessService } from './admin-access.service';
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

  if (!auth.session()) return true;

  // RedirectCommand with replaceUrl, not a bare UrlTree: a plain redirect
  // pushes, so a signed-in user pressing back onto an old /login entry is sent
  // forward to /app on a NEW entry — back then finds /login again, and the
  // button is dead. Replacing consumes the stale entry instead.
  return new RedirectCommand(router.createUrlTree(['/app']), { replaceUrl: true });
};

/**
 * Gates the signup code step, which needs the address the code was sent to.
 *
 * That address lives in AuthService rather than in the URL — deliberately, so
 * it is not in the browser's history or the referrer — which is why a visit
 * with nothing pending has to go back to signup: there is no address to check a
 * code against. That is a reload of /verify-email, a link pasted into a fresh
 * tab, or a second tab where the first one is mid-signup.
 *
 * Server-side this always allows the route through, for the same reason the two
 * guards above do. The server holds no pending address either way, so "nothing
 * pending here" says nothing about the browser; it renders the step and the
 * browser makes the call. Deciding it on the server would also make the
 * prerenderer follow the redirect and emit no page for the route at all.
 *
 * The returnUrl is not carried through the bounce: this is the path where the
 * flow was interrupted and the user is starting over, so there is nothing yet
 * to carry it to. Signing up again from here lands on the default destination.
 */
export const pendingSignupGuard: CanActivateFn = async () => {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return true;
  }

  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.whenRestored();

  if (auth.pendingSignupEmail()) return true;

  // Replaces for the same reason as guestGuard above.
  return new RedirectCommand(router.createUrlTree(['/signup']), { replaceUrl: true });
};

/**
 * Keeps non-admins off the shell's Admin tab. Runs after authGuard on the
 * `app/:tab` route and only acts when that tab is `admin`.
 *
 * A convenience, not the security boundary: the admin API authorizes every
 * request itself (requireAdmin in apps/api). Server-side it lets the route
 * through for the same reason authGuard does — SSR cannot see the session.
 */
export const adminGuard: CanActivateFn = async (route) => {
  if (route.paramMap.get('tab') !== 'admin') return true;
  if (isPlatformServer(inject(PLATFORM_ID))) return true;

  const access = inject(AdminAccessService);
  const router = inject(Router);

  await inject(AuthService).whenRestored();
  if (await access.ensure()) return true;

  return new RedirectCommand(router.createUrlTree(['/app']), { replaceUrl: true });
};
