import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import { ThemeToggle } from '../../shared/theme-toggle';

@Component({
  selector: 'app-reset-password-page',
  imports: [FormsModule, RouterLink, ButtonModule, ProgressSpinnerModule, ThemeToggle],
  styleUrl: './auth-page.css',
  templateUrl: './reset-password-page.html',
})
export class ResetPasswordPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly router = inject(Router);

  protected readonly password = signal('');
  protected readonly confirm = signal('');
  protected readonly passwordVisible = signal(false);
  protected readonly confirmVisible = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  /**
   * Whether the recovery link produced a usable session. Until this is true
   * there is nothing to authorize the password change, so the form stays
   * hidden. Null means "still checking".
   */
  protected readonly ready = signal<boolean | null>(null);

  ngOnInit(): void {
    // Angular ignores whatever ngOnInit returns, so the work is started here
    // and its own rejection path is handled inside restore().
    void this.restore();
  }

  /** Resolves whether the recovery link in the URL produced a usable session. */
  private async restore(): Promise<void> {
    if (!this.supabase.isBrowser) return;

    // Supabase rejects an expired or already-used link by putting the reason in
    // the URL fragment instead of issuing a session.
    const hashError = new URLSearchParams(window.location.hash.slice(1)).get('error_description');
    if (hashError) {
      this.error.set(hashError);
      this.ready.set(false);
      return;
    }

    // supabase-js exchanges the recovery token in the URL for a session as part
    // of its initial restoration, so the session is only known once that ends.
    await this.auth.whenRestored();
    this.ready.set(this.auth.session() !== null);
  }

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  protected toggleConfirmVisibility(): void {
    this.confirmVisible.update((visible) => !visible);
  }

  protected async submit(): Promise<void> {
    if (this.password() !== this.confirm()) {
      this.error.set('The two passwords do not match.');
      return;
    }

    this.busy.set(true);
    this.error.set(null);

    const result = await this.auth.updatePassword(this.password());

    this.busy.set(false);

    if (!result.ok) {
      this.error.set(result.message);
      return;
    }

    // replaceUrl: the recovery link is single-use, so back would land on a
    // reset form whose token has already been spent.
    await this.router.navigateByUrl('/app', { replaceUrl: true });
  }
}
