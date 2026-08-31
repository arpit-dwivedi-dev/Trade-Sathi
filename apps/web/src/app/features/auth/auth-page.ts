import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-auth-page',
  imports: [FormsModule, RouterLink],
  styleUrl: './auth-page.css',
  templateUrl: './auth-page.html',
})
export class AuthPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly mode = signal<'signin' | 'signup' | 'otp'>('signin');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly otp = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);

  /** Email the OTP step is verifying; distinct from `email()` so it survives the field being cleared. */
  private pendingEmail = '';

  protected toggleMode(): void {
    this.mode.update((m) => (m === 'signin' ? 'signup' : 'signin'));
    this.error.set(null);
    this.notice.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.mode() === 'otp') {
      await this.submitOtp();
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

    const email = this.email();
    const password = this.password();
    const result =
      this.mode() === 'signup'
        ? await this.auth.signUp(email, password)
        : await this.auth.signIn(email, password);

    this.busy.set(false);

    if (!result.ok) {
      this.error.set(result.message);
      return;
    }

    if (this.mode() === 'signup') {
      // Signup never signs the user in directly — a code must be confirmed
      // first, so the account can't be used with just an email/password.
      this.pendingEmail = email;
      this.otp.set('');
      this.notice.set(`Enter the 6-digit code we sent to ${email}.`);
      this.mode.set('otp');
      return;
    }

    await this.router.navigateByUrl('/app');
  }

  private async submitOtp(): Promise<void> {
    if (!this.pendingEmail) {
      this.useDifferentEmail();
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

    const result = await this.auth.verifySignupOtp(this.pendingEmail, this.otp());
    this.busy.set(false);

    if (!result.ok) {
      this.error.set(result.message);
      return;
    }

    await this.router.navigateByUrl('/app');
  }

  /** Lets the user correct a mistyped email instead of resending to it forever. */
  protected useDifferentEmail(): void {
    this.mode.set('signup');
    this.otp.set('');
    this.error.set(null);
    this.notice.set(null);
  }

  protected async resendOtp(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

    const result = await this.auth.resendSignupOtp(this.pendingEmail);

    this.busy.set(false);
    this.notice.set(result.ok ? 'Sent a new code.' : null);
    if (!result.ok) this.error.set(result.message);
  }
}
