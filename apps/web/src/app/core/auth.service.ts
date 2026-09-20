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

  /**
   * Whether this render can actually answer "is anyone signed in?".
   *
   * False during SSR and prerendering, where `restored` is true but only
   * because there is no browser storage to consult — the honest answer there
   * is "unknown", and a screen that treats it as "signed out" bakes a
   * signed-out view into static HTML. That is what made an already signed-in
   * user see the sign-in card flash before guestGuard could redirect them.
   */
  readonly sessionKnown = computed(() => this.supabase.isBrowser && this._restored());

  /**
   * The address `/signup` sent a code to, for `/verify-email` to confirm.
   *
   * Signup and the code step are separate routes now, so the two screens cannot
   * share a component field the way they did when both were modes of one
   * /login. Deliberately not carried in the URL either: the address would then
   * sit in the browser's history, in the referrer header, and in front of
   * anyone looking over the user's shoulder.
   */
  private readonly _pendingSignupEmail = signal<string | null>(null);
  readonly pendingSignupEmail = this._pendingSignupEmail.asReadonly();

  /** Called by `/signup` once the verification code has been sent. */
  setPendingSignupEmail(email: string): void {
    this._pendingSignupEmail.set(email);
  }

  /**
   * Called by `/verify-email` once the code is confirmed, and when the user
   * asks to start over with a different address — at which point the code
   * already sent is worthless.
   */
  clearPendingSignupEmail(): void {
    this._pendingSignupEmail.set(null);
  }

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
   * Hands the browser off to Google's consent screen.
   *
   * Nothing is returned on success: supabase-js navigates away, and the user
   * comes back to `/auth/callback` with a code in the URL that the client
   * exchanges for a session (detectSessionInUrl — see SupabaseClientService).
   * The returnUrl rides in the callback URL rather than in memory because the
   * round trip leaves the app entirely and this instance does not survive it.
   */
  async signInWithGoogle(returnUrl: string): Promise<AuthResult> {
    const client = this.supabase.client;
    if (!client) return NOT_AVAILABLE;

    const callback = new URL('/auth/callback', window.location.origin);
    callback.searchParams.set('returnUrl', returnUrl);

    // skipBrowserRedirect, then replace rather than assign: left to itself
    // supabase-js pushes the hand-off to Google onto the history stack, so
    // pressing back from the app re-requested Supabase's authorize URL with a
    // state that had already been spent — which bounced the user to the site
    // root carrying ?error=bad_oauth_state. Replacing means the whole round
    // trip occupies the entry this screen already had, and the callback then
    // replaces that in turn with the destination.
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callback.toString(), skipBrowserRedirect: true },
    });

    if (error) return { ok: false, message: error.message };
    if (!data.url) return { ok: false, message: 'Could not reach Google. Please try again.' };

    window.location.replace(data.url);
    return { ok: true };
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
