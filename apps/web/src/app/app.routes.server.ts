import { RenderMode, ServerRoute } from '@angular/ssr';

import { TABS } from './shared/nav-rail/nav-tabs';

export const serverRoutes: ServerRoute[] = [
  // Analysis reports are user-specific and identified by a dynamic id. Let the
  // browser load them so Supabase can restore the signed-in session first.
  {
    path: 'analysis/:id',
    renderMode: RenderMode.Client,
  },
  // The Google return trip. Prerendered, not client-rendered, because the
  // deployment is static: a route with no prerendered file falls through to
  // the catch-all rewrite, which serves the landing page. That put a fully
  // rendered landing page on screen for the whole of the return trip, then
  // blanked it when the router caught up — so the user saw landing, white,
  // dashboard instead of one spinner.
  //
  // A prerendered copy is a spinner frozen before the code is exchanged, and
  // that is exactly the right first paint: the exchange is the browser
  // Supabase client's job (detectSessionInUrl) and runs on hydration, so the
  // static shell is the same spinner the component would have drawn anyway.
  // A redirect into /app/admin — nothing to prerender for an open-ended param.
  {
    path: 'admin/:section',
    renderMode: RenderMode.Client,
  },
  {
    path: 'auth/callback',
    renderMode: RenderMode.Prerender,
  },
  // The shell's tab is a route parameter, so the prerenderer has to be told
  // which values exist — under RenderMode.Prerender an unenumerated parameter
  // fails the build rather than falling back. Every tab server-renders the same
  // no-session loading shell, so these are cheap and identical on purpose.
  // The TAB_ALIASES values are deliberately absent: a hard load of, say,
  // /app/pricing is resolved by parseTab in the browser instead.
  {
    path: 'app/:tab',
    renderMode: RenderMode.Prerender,
    getPrerenderParams: () => Promise.resolve(TABS.map((tab) => ({ tab }))),
  },
  {
    path: '**',
    renderMode: RenderMode.Prerender,
  },
];
