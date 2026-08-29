import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-auth-page',
  imports: [FormsModule],
  templateUrl: './auth-page.html',
})
export class AuthPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly mode = signal<'signin' | 'signup'>('signin');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected toggleMode(): void {
    this.mode.update((m) => (m === 'signin' ? 'signup' : 'signin'));
    this.error.set(null);
    this.notice.set(null);
  }

  protected async submit(): Promise<void> {
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

    if (!this.auth.session()) {
      // Sign-up succeeded but the project requires email confirmation, so
      // there is no session to send to /app yet.
      this.notice.set('Check your email to confirm your account, then sign in.');
      this.mode.set('signin');
      return;
    }

    await this.router.navigateByUrl('/app');
  }
}
