import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AnalyzeService, type QuotaStatus } from '../analyze/analyze.service';
import { BillingService } from '../billing/billing.service';
import { BuyCreditsButton } from '../billing/buy-credits-button';
import { UpgradeButton } from '../billing/upgrade-button';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

/**
 * Account and plan. Read-only by design: it draws on the surfaces that already
 * exist — the session for identity and AnalyzeService.fetchQuota() for this
 * period's usage against the plan allowance, plus BillingService.
 * ensurePlanSummary() for the plan and its add-ons. No new endpoint is introduced — both
 * reads go straight to Supabase under existing RLS policies.
 */
@Component({
  selector: 'app-account-page',
  imports: [UpgradeButton, BuyCreditsButton, RouterLink, DatePipe],
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

  /**
   * Read from the shared BillingService cache, not a private copy. This page
   * embeds the plan picker, and the picker decides which cards are still
   * purchasable from that same cache — filling a local signal instead left the
   * cache empty, so the picker had no idea which plan or add-ons the user
   * already held and offered them all over again.
   */
  protected readonly plan = this.billing.currentPlan;
  protected readonly addOns = computed(() => this.plan()?.addOns ?? []);
  protected readonly briefingCredits = computed(() => this.plan()?.briefingCreditBalance ?? 0);
  protected readonly briefingUsage = computed(() => this.plan()?.briefingUsage ?? null);
  protected readonly analysisCredits = computed(() => this.plan()?.creditBalance ?? 0);
  protected readonly loading = signal(true);

  /**
   * Whether the briefing block is worth rendering at all. Credits alone are
   * enough: they are spent with no subscription held, so a user who bought a
   * pack and let the add-on lapse must still see what they own.
   */
  protected readonly showBriefing = computed(
    () => this.briefingUsage() !== null || this.briefingCredits() > 0,
  );

  /**
   * True once the monthly allowance is spent AND no credits remain — the only
   * state in which the next manual analysis is actually refused. Kept as one
   * predicate because the copy and the CTA both hinge on it, and splitting it
   * let the screen say "you're out" while credits were still being spent.
   */
  protected readonly analysesExhausted = computed(() => {
    const quota = this.quota();
    return quota !== null && quota.remaining === 0 && this.analysisCredits() === 0;
  });

  ngOnInit(): void {
    void this.load();
  }

  /**
   * A top-up only shows up in the balance once the webhook has captured it, so
   * re-read rather than optimistically incrementing — the same reason the
   * purchase flow polls instead of trusting Razorpay's client-side callback.
   */
  protected onCreditsAdded(): void {
    void this.billing.refreshPlanSummary();
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

  protected briefingUsedPercent(): number {
    const usage = this.briefingUsage();
    if (!usage || usage.limit <= 0) return 0;
    return Math.min(100, Math.round((usage.used / usage.limit) * 100));
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    const [quota] = await Promise.all([
      this.analyze.fetchQuota(),
      // ensure, not fetch: this both fills the shared cache the picker reads
      // and reuses it if another surface (the nav's upgrade entry point) has
      // already loaded it.
      this.billing.ensurePlanSummary(),
    ]);
    this.quota.set(quota);
    this.loading.set(false);
  }
}
