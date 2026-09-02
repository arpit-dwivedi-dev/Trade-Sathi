import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';

import { AnalyzeService, type QuotaStatus } from '../analyze/analyze.service';
import { BillingService } from './billing.service';
import { BuyCreditsButton } from './buy-credits-button';
import { UpgradeButton } from './upgrade-button';

/**
 * Billing, as one screen: what's held, what's left, and both ways to get more.
 *
 * Deliberately not split into a "Pricing" tab and a "Credits" tab. A plan and a
 * credit pack are two answers to the same question — "I need more analyses" —
 * and putting them behind separate nav entries made the user pick the route
 * before they could compare the options. The account page keeps no billing
 * surface at all now; it is identity only.
 */
@Component({
  selector: 'app-billing-page',
  imports: [BuyCreditsButton, UpgradeButton, DatePipe],
  styleUrl: './billing-page.css',
  templateUrl: './billing-page.html',
})
export class BillingPage implements OnInit {
  private readonly analyze = inject(AnalyzeService);
  private readonly billing = inject(BillingService);

  protected readonly quota = signal<QuotaStatus | null>(null);
  protected readonly loading = signal(true);

  /**
   * The shared BillingService cache, not a private copy. The picker below marks
   * the held tier and add-ons from this same cache — filling a local signal
   * instead left it empty, and the picker offered plans the user already had.
   */
  protected readonly plan = this.billing.currentPlan;
  protected readonly addOns = computed(() => this.plan()?.addOns ?? []);
  protected readonly analysisCredits = computed(() => this.plan()?.creditBalance ?? 0);
  protected readonly briefingCredits = computed(() => this.plan()?.briefingCreditBalance ?? 0);
  protected readonly briefingUsage = computed(() => this.plan()?.briefingUsage ?? null);

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
    void this.refreshQuota();
  }

  /** An upgrade changes the allowance, so the meter has to be re-read too. */
  protected onUpgraded(): void {
    void this.billing.refreshPlanSummary();
    void this.refreshQuota();
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

  private async load(): Promise<void> {
    this.loading.set(true);
    await Promise.all([
      this.refreshQuota(),
      // ensure, not fetch: the shell already loaded this on mount, and both the
      // summary above and the picker below read the cache it fills.
      this.billing.ensurePlanSummary(),
    ]);
    this.loading.set(false);
  }

  private async refreshQuota(): Promise<void> {
    this.quota.set(await this.analyze.fetchQuota());
  }
}
