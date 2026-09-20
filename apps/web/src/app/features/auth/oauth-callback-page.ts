import { Component, Injector, OnInit, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Session } from '@supabase/supabase-js';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AuthService } from '../../core/auth.service';

/** Where a signed-in user goes when the callback carried no destination. */
const DEFAULT_RETURN_URL = '/app';

/**
 * How long to wait for a session before giving up.
 *
 * There is a timeout at all because the alternative was worse: this screen
 * awaited session restoration with nothing behind it, so anything that left
 * that promise unsettled — a stale Supabase storage lock is the known one —
 * left the user on a spinner with no session, no error and no way out.
 */
const SESSION_TIMEOUT_MS = 15_000;

/**
 * Where Google returns the user to.
 *
 * There is no token handling here: the Supabase client is created with
 * `detectSessionInUrl`, so it trades the `?code=` in this URL for a session on
 * its own. This screen only waits for that session to appear and then forwards
 * — it exists as its own route so the return trip lands somewhere that expects
 * a code, rather than on /login, where guestGuard would be racing the exchange.
 */
@Component({
  selector: 'app-oauth-callback-page',
  imports: [RouterLink, ProgressSpinnerModule],
  styleUrl: './auth-page.css',
  template: `
    @if (error(); as message) {
      <main class="auth">
        <div class="auth-card">
          <div class="auth-head">
            <h1>Sign-in failed</h1>
            <p class="err" role="alert">{{ message }}</p>
          </div>
          <div class="auth-foot"><a routerLink="/login">Back to sign in</a></div>
        </div>
      </main>
    } @else {
      <!-- Deliberately the app shell's own loading state, down to the markup:
           this screen hands straight over to it, and two differently-worded
           spinners in a row read as two waits rather than one. The auth card
           is not drawn around it for the same reason. -->
      <div class="callback-loading">
        <p-progress-spinner
          [style]="{ width: '28px', height: '28px' }"
          strokeWidth="4"
          aria-hidden="true"
        />
        <p class="lbl">Loading</p>
      </div>
    }
  `,
})
export class OauthCallbackPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);

  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.complete();
  }

  private async complete(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;

    // Google (or Supabase) can refuse before any code is issued — a cancelled
    // consent screen is the common case — in which case the failure arrives as
    // query params and there is nothing to wait for.
    const failure = params.get('error_description') ?? params.get('error');
    if (failure) {
      this.error.set(failure);
      return;
    }

    const session = await this.awaitSession();
    if (!session) {
      this.error.set('We could not complete the sign-in. Please try again.');
      return;
    }

    const requested = params.get('returnUrl');
    // Same open-redirect rule as AuthPage: in-app paths only.
    const target =
      requested?.startsWith('/') && !requested.startsWith('//') ? requested : DEFAULT_RETURN_URL;

    // In-app hop first, full page load only if it does not take.
    //
    // The Supabase client rewrites this URL with history.replaceState when it
    // consumes the `?code=`, and when that lands mid-navigation the router's
    // idea of where it is goes out of step with the address bar — the hop then
    // does nothing at all. A reload always works, but it boots the whole app
    // again, so the user watches this screen's spinner and then the shell's.
    // So: try the hop, and fall back to the reload only when the address bar
    // says it was ignored.
    // replaceUrl for the same reason the fallback below uses location.replace:
    // this screen is a staging post, not somewhere to come back to.
    const moved = await this.router
      .navigateByUrl(target, { replaceUrl: true })
      .catch(() => false);
    if (moved && window.location.pathname !== '/auth/callback') return;

    window.location.replace(target);
  }

  /**
   * The session, once it exists, or null if it never turns up.
   *
   * Two routes to the same answer, deliberately, because they fail
   * independently: the restoration promise resolves once the client has
   * finished initialising, while the signal is written by the client's own
   * auth-state listener. Whichever reports first wins, so a session that
   * arrives while restoration is still stuck is not missed.
   */
  private awaitSession(): Promise<Session | null> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (session: Session | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watcher.destroy();
        resolve(session);
      };

      const timer = setTimeout(() => finish(null), SESSION_TIMEOUT_MS);

      // manualCleanup: this effect outlives nothing but the promise, and is
      // destroyed by finish() rather than by the component's lifecycle.
      const watcher = effect(
        () => {
          const session = this.auth.session();
          if (session) finish(session);
        },
        { injector: this.injector, manualCleanup: true },
      );

      void this.auth.whenRestored().then(() => finish(this.auth.session()));
    });
  }
}
