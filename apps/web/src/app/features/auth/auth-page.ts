import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AuthService } from '../../core/auth.service';

/**
 * Supabase's own default minimum. Checked here only so an obviously too-short
 * password fails instantly instead of after a round trip — the server remains
 * the authority, and this deliberately does not add rules it would not enforce.
 */
const MIN_PASSWORD_LENGTH = 6;

/** The length of the signup code, so a half-typed one is not submitted. */
const OTP_LENGTH = 6;

/** How long the resend control stays disabled after a code is sent. */
const RESEND_COOLDOWN_SECONDS = 30;

/** Where a signed-in user goes when nothing else asked for a destination. */
const DEFAULT_RETURN_URL = '/app';

/**
 * Which of the flow's three screens a route renders. The routes themselves are
 * in app.routes.ts — /login, /signup and /verify-email — and each one names its
 * mode in the route's data.
 */
export type AuthMode = 'signin' | 'signup' | 'otp';

/**
 * Signing in, signing up, and confirming a signup code.
 *
 * All three are this one component, because they are one card with a field or
 * two swapped between them — but each is its own route, so each has its own
 * address. Which one is on screen comes from the route's data rather than from
 * a field here: as separate route configurations, a move between them builds a
 * new instance anyway, so there is nothing for an internal mode to track.
 */
@Component({
  selector: 'app-auth-page',
  imports: [FormsModule, RouterLink, ButtonModule, ProgressSpinnerModule],
  styleUrl: './auth-page.css',
  templateUrl: './auth-page.html',
})
export class AuthPage implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly mode = this.route.snapshot.data['mode'] as AuthMode;
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly passwordVisible = signal(false);
  protected readonly otp = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);

  /** Seconds until "Resend code" is available again; 0 when it is. */
  protected readonly resendIn = signal(0);
  private resendTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Where to go after signing in. Set by authGuard when it turned a visit to a
   * protected page into a redirect here, so the user lands on the page they
   * actually asked for rather than always on /app. Carried across the signup →
   * verify-email hop so it survives the email being confirmed on another route.
   */
  private returnUrl = DEFAULT_RETURN_URL;

  ngOnInit(): void {
    const requested = this.route.snapshot.queryParamMap.get('returnUrl');
    // Only same-origin, in-app paths: a returnUrl is attacker-supplied in the
    // general case, and following an absolute or protocol-relative one would
    // make this an open redirect.
    if (requested?.startsWith('/') && !requested.startsWith('//')) {
      this.returnUrl = requested;
    }

    if (this.mode === 'otp') this.startOtpStep();
  }

  /**
   * The returnUrl as query params, or nothing when it is only the default —
   * so the common case does not put a redundant `?returnUrl=%2Fapp` on the URL.
   */
  protected get returnUrlQuery(): { returnUrl?: string } {
    return this.returnUrl === DEFAULT_RETURN_URL ? {} : { returnUrl: this.returnUrl };
  }

  ngOnDestroy(): void {
    this.stopResendCountdown();
  }

  /**
   * Sets up the code step: whose code is being confirmed, and how long until it
   * may be resent.
   *
   * Nothing here decides whether this screen may be shown at all — that is
   * pendingSignupGuard's job, which is why it can read the address without
   * checking for one first.
   */
  private startOtpStep(): void {
    const email = this.auth.pendingSignupEmail();
    if (!email) return;

    this.notice.set(`Enter the ${OTP_LENGTH}-digit code we sent to ${email}.`);
    this.startResendCountdown();
  }

  private startResendCountdown(): void {
    this.stopResendCountdown();
    this.resendIn.set(RESEND_COOLDOWN_SECONDS);
    this.resendTimer = setInterval(() => {
      this.resendIn.update((seconds) => Math.max(0, seconds - 1));
      if (this.resendIn() === 0) this.stopResendCountdown();
    }, 1_000);
  }

  private stopResendCountdown(): void {
    if (this.resendTimer !== null) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }

  /**
   * The first thing wrong with the credentials, or null.
   *
   * Angular puts `novalidate` on every form it manages, so the `required` and
   * `type="email"` attributes in the template never actually block a submit —
   * an empty form went all the way to Supabase and came back with its wording,
   * not ours.
   */
  private credentialProblem(email: string, password: string): string | null {
    if (!email.trim()) return 'Enter your email address.';
    // Deliberately loose: the mail server is the only real authority on whether
    // an address exists, and a strict pattern mostly rejects valid addresses.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return 'That email address does not look right.';
    }
    if (!password) return 'Enter your password.';
    if (this.mode === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
    }
    return null;
  }

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  protected async submit(): Promise<void> {
    if (this.mode === 'otp') {
      await this.submitOtp();
      return;
    }

    if (this.busy()) return;

    const email = this.email().trim();
    const password = this.password();

    const problem = this.credentialProblem(email, password);
    if (problem) {
      this.error.set(problem);
      this.notice.set(null);
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

    const result =
      this.mode === 'signup'
        ? await this.auth.signUp(email, password)
        : await this.auth.signIn(email, password);

    this.busy.set(false);

    if (!result.ok) {
      this.error.set(result.message);
      return;
    }

    if (this.mode === 'signup') {
      // Signup never signs the user in directly — a code must be confirmed
      // first, so the account can't be used with just an email/password. The
      // address is handed over rather than put in the URL, and the confirmation
      // is a navigation to its own route.
      this.auth.setPendingSignupEmail(email);
      await this.router.navigate(['/verify-email'], { queryParams: this.returnUrlQuery });
      return;
    }

    await this.router.navigateByUrl(this.returnUrl);
  }

  private async submitOtp(): Promise<void> {
    if (this.busy()) return;

    const email = this.auth.pendingSignupEmail();
    if (!email) {
      // Nothing to verify against. The redirect in startOtpStep normally gets
      // here first; this covers the code step being reached some other way.
      this.useDifferentEmail();
      return;
    }

    const code = this.otp().trim();
    if (code.length !== OTP_LENGTH) {
      this.error.set(`Enter all ${OTP_LENGTH} digits of the code.`);
      this.notice.set(null);
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

    const result = await this.auth.verifySignupOtp(email, code);
    this.busy.set(false);

    if (!result.ok) {
      this.error.set(result.message);
      return;
    }

    // Confirmed, so there is nothing left to come back to this screen for.
    this.auth.clearPendingSignupEmail();
    await this.router.navigateByUrl(this.returnUrl);
  }

  /** Lets the user correct a mistyped email instead of resending to it forever. */
  protected useDifferentEmail(): void {
    this.auth.clearPendingSignupEmail();
    void this.router.navigate(['/signup'], { queryParams: this.returnUrlQuery });
  }

  protected async resendOtp(): Promise<void> {
    // The cooldown is the point: without it the button could be held down,
    // and every press is another email to a real inbox.
    const email = this.auth.pendingSignupEmail();
    if (this.busy() || this.resendIn() > 0 || !email) return;

    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

    const result = await this.auth.resendSignupOtp(email);

    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.message);
      return;
    }
    this.notice.set('Sent a new code.');
    this.startResendCountdown();
  }
}
