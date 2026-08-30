import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AnalyzeService, type QuotaStatus } from '../analyze/analyze.service';
import { BillingService, type PlanSummary } from '../billing/billing.service';
import { UpgradeButton } from '../billing/upgrade-button';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

/**
 * Account and plan. Read-only by design: it draws on the surfaces that already
 * exist — the session for identity and AnalyzeService.fetchQuota() for this
 * period's usage against the plan allowance, plus BillingService.
 * fetchPlanSummary() for the plan itself. No new endpoint is introduced — both
 * reads go straight to Supabase under existing RLS policies.
 */
@Component({
  selector: 'app-account-page',
  imports: [UpgradeButton, RouterLink, DatePipe],
  styleUrl: './account-page.css',
  templateUrl: './account-page.html',
})
export class AccountPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly analyze = inject(AnalyzeService);
  private readonly billing = inject(BillingService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);

  protected readonly user = this.auth.user;
  protected readonly theme = this.themeService.theme;
  protected readonly quota = signal<QuotaStatus | null>(null);
  protected readonly plan = signal<PlanSummary | null>(null);
  protected readonly loading = signal(true);

  ngOnInit(): void {
    void this.load();
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  /** Paise -> "₹499" / "₹0". Money is integer minor units end to end. */
  protected priceLabel(paise: number): string {
    return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
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
    const [quota, plan] = await Promise.all([
      this.analyze.fetchQuota(),
      this.billing.fetchPlanSummary(),
    ]);
    this.quota.set(quota);
    this.plan.set(plan);
    this.loading.set(false);
  }
}
