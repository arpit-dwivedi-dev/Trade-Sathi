import { Injectable, computed, inject, signal } from '@angular/core';
import type { Session, User } from '@supabase/supabase-js';
import { isDisposableEmail } from '@tradesathi/shared';

import { SupabaseClientService } from './supabase-client';
import { environment } from '../../environments/environment';

/** Methods report failure as a value so components never need try/catch. */
export type AuthResult = { ok: true } | { ok: false; message: string };

const NOT_AVAILABLE: AuthResult = { ok: false, message: 'Not available on the server.' };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly supabase = inject(SupabaseClientService);

  private readonly _session = signal<Session | null>(null);
  private readonly _restored = signal(false);

  /** Current session, or null when signed out. Always null on the server. */
  readonly session = this._session.asReadonly();
  readonly user = computed<User | null>(() => this._session()?.user ?? null);

  /**
   * Whether the initial session restoration has finished. Distinct from
   * `session() === null`: before this flips true, a null session means
   * "not known yet", not "signed out".
   */
  readonly restored = this._restored.asReadonly();

  private readonly restoredPromise: Promise<void>;

  constructor() {
    const client = this.supabase.client;

    if (!client) {
      // SSR: there is no browser storage to restore from. Mark restoration as
      // complete so nothing awaits forever, with a null session.
      this._restored.set(true);
      this.restoredPromise = Promise.resolve();
      return;
    }

    this.restoredPromise = client.auth
      .getSession()
      .then(({ data }) => {
        this._session.set(data.session);
      })
      .catch(() => {
        this._session.set(null);
      })
      .then(() => {
        this._restored.set(true);
      });

    client.auth.onAuthStateChange((_event, session) => {
      this._session.set(session);
      this._restored.set(true);
    });
  }

  /** Resolves once the initial session restoration has completed. */
  whenRestored(): Promise<void> {
    return this.restoredPromise;
  }

  /**
   * Access token for calling the backend's Bearer-authenticated endpoints.
   * Returns null on the server rather than touching browser storage.
   */
  async getAccessToken(): Promise<string | null> {
    const client = this.supabase.client;
    if (!client) return null;

    await this.restoredPromise;
    const { data } = await client.auth.getSession();
    const session = data.session;
    if (!session) return null;

    // getSession() returns whatever is cached in storage, which can be a
    // token past its expiry if the background autoRefreshToken timer missed
    // a beat (backgrounded tab, laptop sleep, long-lived session). Refresh it
    // explicitly rather than send a request doomed to 401.
    const expiresAt = session.expires_at;
    if (expiresAt !== undefined && expiresAt * 1000 <= Date.now()) {
      const { data: refreshed, error } = await client.auth.refreshSession();
      if (error || !refreshed.session) {
        this._session.set(null);
        return null;
      }
      this._session.set(refreshed.session);
      return refreshed.session.access_token;
    }

    return session.access_token;
  }

  async signUp(email: string, password: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    // Fast path only. The `before_user_created` auth hook is the real
    // boundary and rejects the full disposable-domain list server-side.
    // Skipped outside production so temp emails work for local dev signups.
    if (environment.production && isDisposableEmail(email)) {
      return {
        ok: false,
        message:
          'Please sign up with a permanent email address — temporary and disposable email providers are not accepted.',
      };
    }

    const { error } = await client.auth.signUp({ email, password });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  /**
   * Confirms the 6-digit code from the signup email, establishing a session.
   * This is the second step required before a new account can sign in.
   */
  async verifySignupOtp(email: string, token: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    const { error } = await client.auth.verifyOtp({ email, token, type: 'signup' });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  /** Re-sends the signup verification code. */
  async resendSignupOtp(email: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    const { error } = await client.auth.resend({ type: 'signup', email });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    const { error } = await client.auth.signInWithPassword({ email, password });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  /**
   * Sends a password-recovery email. The link in it returns to
   * `/reset-password`, where supabase-js exchanges the token in the URL for a
   * short-lived session that authorizes `updatePassword`.
   */
  async requestPasswordReset(email: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  /** Sets a new password for the session established by a recovery link. */
  async updatePassword(password: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    const { error } = await client.auth.updateUser({ password });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  async signOut(): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    const { error } = await client.auth.signOut();
    return error ? { ok: false, message: error.message } : { ok: true };
  }
}
