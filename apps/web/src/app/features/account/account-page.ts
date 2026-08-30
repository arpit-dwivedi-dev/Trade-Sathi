import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AnalyzeService, type QuotaStatus } from '../analyze/analyze.service';
import { UpgradeButton } from '../billing/upgrade-button';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

/**
 * Account and plan. Read-only by design: it draws on the surfaces that already
 * exist — the session for identity and AnalyzeService.fetchQuota() for this
 * period's usage against the plan allowance. No new endpoint is introduced,
 * so anything the backend does not already expose (plan name, price, renewal
 * date) is simply not shown.
 */
@Component({
  selector: 'app-account-page',
  imports: [UpgradeButton, RouterLink],
  styleUrl: './account-page.css',
  templateUrl: './account-page.html',
})
export class AccountPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly analyze = inject(AnalyzeService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);

  protected readonly user = this.auth.user;
  protected readonly theme = this.themeService.theme;
  protected readonly quota = signal<QuotaStatus | null>(null);
  protected readonly loading = signal(true);

  ngOnInit(): void {
    void this.load();
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected usedPercent(): number {
    const quota = this.quota();
    if (!quota || quota.limit <= 0) return 0;
    return Math.min(100, Math.round((quota.used / quota.limit) * 100));
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.quota.set(await this.analyze.fetchQuota());
    this.loading.set(false);
  }
}
