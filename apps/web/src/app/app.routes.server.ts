import { RenderMode, ServerRoute } from '@angular/ssr';

import { TABS } from './shared/nav-rail/nav-tabs';

export const serverRoutes: ServerRoute[] = [
  // Analysis reports are user-specific and identified by a dynamic id. Let the
  // browser load them so Supabase can restore the signed-in session first.
  {
    path: 'analysis/:id',
    renderMode: RenderMode.Client,
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
