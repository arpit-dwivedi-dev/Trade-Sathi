import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { SupabaseClient, createClient } from '@supabase/supabase-js';

import { environment } from '../../environments/environment';

/**
 * Owns the single Supabase client instance.
 *
 * The client is only created in the browser: supabase-js reaches for
 * localStorage to persist and restore the session, which does not exist during
 * SSR. On the server `client` is null and callers must skip session access
 * entirely rather than treating it as "signed out".
 */
@Injectable({ providedIn: 'root' })
export class SupabaseClientService {
  private readonly platformId = inject(PLATFORM_ID);

  readonly isBrowser = isPlatformBrowser(this.platformId);

  readonly client: SupabaseClient | null = this.isBrowser
    ? createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;
}
