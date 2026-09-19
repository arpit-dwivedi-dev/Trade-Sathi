import { CanActivateFn, Route, Routes } from '@angular/router';

import { authGuard, guestGuard, pendingSignupGuard } from './core/auth.guard';
import { parseTab } from './shared/nav-rail/nav-tabs';
import type { AuthMode } from './features/auth/auth-page';

/**
 * One address for each of the auth flow's three screens. They are the same
 * component — see AuthPage — so what distinguishes them is the mode in the
 * route's data, which is read back off `route.snapshot.data` there.
 */
function authStep(path: string, mode: AuthMode, extraGuards: CanActivateFn[] = []): Route {
  return {
    path,
    canActivate: [guestGuard, ...extraGuards],
    data: { mode },
    loadComponent: () => import('./features/auth/auth-page').then((m) => m.AuthPage),
  };
}

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/landing/landing-page').then((m) => m.LandingPage),
  },
  authStep('login', 'signin'),
  authStep('signup', 'signup'),
  // The step after signup, at its own address rather than a mode of /signup:
  // it is the one screen of the flow a user is most likely to come back to
  // after checking their inbox, and a reload has to land somewhere real.
  // pendingSignupGuard is what decides "somewhere real" — see auth.guard.ts.
  authStep('verify-email', 'otp', [pendingSignupGuard]),
  {
    path: 'forgot-password',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/auth/forgot-password-page').then((m) => m.ForgotPasswordPage),
  },
  {
    path: 'reset-password',
    loadComponent: () =>
      import('./features/auth/reset-password-page').then((m) => m.ResetPasswordPage),
  },
  // The app shell. One route with the tab as a parameter, rather than one route
  // per tab, and that is load-bearing: with a single route config Angular
  // reuses the component as the tab changes, so the panes the shell keeps
  // mounted while hidden — an in-flight analysis, a chart mid-poll — survive a
  // tab switch. One route per tab would tear them down and rebuild them.
  {
    path: 'app/:tab',
    canActivate: [authGuard],
    loadComponent: () => import('./features/app/app-page').then((m) => m.AppPage),
  },
  // Bare /app: the rail's brand link, the sign-in landing, and every URL
  // written against the old query-param form. The tab is read here so that
  // `/app?tab=billing` still lands on Billing instead of the default tab.
  {
    path: 'app',
    pathMatch: 'full',
    redirectTo: ({ queryParamMap }) => `/app/${parseTab(queryParamMap.get('tab'))}`,
  },
  {
    path: 'analysis/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/history/analysis-detail-page').then((m) => m.AnalysisDetailPage),
  },
  // Account and Chart Analysis moved into the shell as tab addresses. These
  // only exist so a link or bookmark written against the old standalone URLs
  // still lands somewhere real rather than falling through to the catch-all
  // below. The shell's own former ids — /app/workspace, /app/logs, /app/account
  // — need no stub: they are matched by `app/:tab` and resolved by parseTab's
  // TAB_ALIASES, which is also what keeps /app?tab=pricing working.
  {
    path: 'account',
    redirectTo: '/app/account-settings',
  },
  {
    path: 'workspace',
    redirectTo: '/app/symbol-search',
  },
  // Catch-all. Without it the router matched nothing for an unknown URL — a
  // mistyped path, or a stale bookmark — and left the page blank with only a
  // console error. A redirect rather than a component so the prerenderer has no
  // extra page to render.
  {
    path: '**',
    redirectTo: '',
  },
];
