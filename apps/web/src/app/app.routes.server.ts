import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  // Analysis reports are user-specific and identified by a dynamic id. Let the
  // browser load them so Supabase can restore the signed-in session first.
  {
    path: 'analysis/:id',
    renderMode: RenderMode.Client,
  },
  {
    path: '**',
    renderMode: RenderMode.Prerender,
  },
];
