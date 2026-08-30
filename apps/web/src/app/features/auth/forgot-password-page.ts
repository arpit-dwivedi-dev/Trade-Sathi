import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-forgot-password-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './forgot-password-page.html',
})
export class ForgotPasswordPage {
  private readonly auth = inject(AuthService);

  protected readonly email = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly sent = signal(false);
  protected readonly busy = signal(false);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);

    const result = await this.auth.requestPasswordReset(this.email());

    this.busy.set(false);

    if (!result.ok) {
      this.error.set(result.message);
      return;
    }

    this.sent.set(true);
  }
}
