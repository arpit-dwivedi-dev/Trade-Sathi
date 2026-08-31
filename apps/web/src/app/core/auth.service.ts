import { Injectable, computed, inject, signal } from '@angular/core';
import type { Session, User } from '@supabase/supabase-js';
import { isDisposableEmail } from '@chartanalyzer/shared';

import { SupabaseClientService } from './supabase-client';

/** Methods report failure as a value so components never need try/catch. */
export type AuthResult = { ok: true } | { ok: false; message: string };

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
    return data.session?.access_token ?? null;
  }

  async signUp(email: string, password: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return { ok: false, message: 'Not available on the server.' };

    if (isDisposableEmail(email)) {
      return {
        ok: false,
        message: 'Please sign up with a permanent email address — temporary/disposable emails are not allowed.',
      };
    }

    const { error } = await client.auth.signUp({ email, password });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return { ok: false, message: 'Not available on the server.' };

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
    if (!client) return { ok: false, message: 'Not available on the server.' };

    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  /** Sets a new password for the session established by a recovery link. */
  async updatePassword(password: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return { ok: false, message: 'Not available on the server.' };

    const { error } = await client.auth.updateUser({ password });
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  async signOut(): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return { ok: false, message: 'Not available on the server.' };

    const { error } = await client.auth.signOut();
    return error ? { ok: false, message: error.message } : { ok: true };
  }
}
