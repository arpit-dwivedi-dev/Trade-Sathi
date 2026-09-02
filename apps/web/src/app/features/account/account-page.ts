import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

/**
 * Identity only. Everything billing — plans, usage, credits — lives on the
 * Billing tab, so this page reads nothing but the session and is the place
 * profile settings get added as they arrive.
 */
@Component({
  selector: 'app-account-page',
  imports: [RouterLink, DatePipe],
  styleUrl: './account-page.css',
  templateUrl: './account-page.html',
})
export class AccountPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);

  protected readonly user = this.auth.user;
  protected readonly theme = this.themeService.theme;
  /** Drawer state. Only consulted below 900px, where the rail is off-canvas. */
  protected readonly navOpen = signal(false);

  /** Supabase stamps this on the auth user; absent on a session shape without it. */
  protected readonly memberSince = computed(() => this.user()?.created_at ?? null);

  protected toggleNav(): void {
    this.navOpen.update((open) => !open);
  }

  protected closeNav(): void {
    this.navOpen.set(false);
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
