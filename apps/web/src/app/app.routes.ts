import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/landing/landing-page').then((m) => m.LandingPage),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/auth-page').then((m) => m.AuthPage),
  },
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
  {
    path: 'app',
    canActivate: [authGuard],
    loadComponent: () => import('./features/app/app-page').then((m) => m.AppPage),
  },
  {
    path: 'account',
    canActivate: [authGuard],
    loadComponent: () => import('./features/account/account-page').then((m) => m.AccountPage),
  },
  // Manual Analysis is a tab inside the dashboard shell now (so the nav rail
  // stays visible by default), not its own route — this only exists so a
  // link or bookmark written against the old standalone /workspace URL still
  // lands somewhere real rather than falling through to the catch-all below.
  {
    path: 'workspace',
    redirectTo: () => '/app?tab=workspace',
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
