import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { CardModule } from 'primeng/card';
import { ProgressBarModule } from 'primeng/progressbar';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AnalyzeService, type QuotaStatus } from '../analyze/analyze.service';
import { BillingService, formatPriceMinor } from './billing.service';
import { BuyCreditsButton } from './buy-credits-button';
import { PromoRedeemBox } from './promo-redeem-box';
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
  imports: [
    BuyCreditsButton,
    UpgradeButton,
    PromoRedeemBox,
    DatePipe,
    CardModule,
    ProgressBarModule,
    ProgressSpinnerModule,
  ],
  styleUrl: './billing-page.css',
  templateUrl: './billing-page.html',
})
export class BillingPage implements OnInit {
  private readonly analyze = inject(AnalyzeService);
  private readonly billing = inject(BillingService);

  protected readonly quota = signal<QuotaStatus | null>(null);
  protected readonly loading = signal(true);

  /**
   * Lets the shell reset any other screen's stale "out of analyses" state
   * once a plan or credit purchase actually lands — the same signal the
   * plans overlay used to emit before Billing became a plain tab instead of
   * a popup.
   */
  readonly upgraded = output<void>();
  readonly creditsAdded = output<void>();

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
   * The account's locked price band, as a display label — or null until the
   * summary has loaded, so the badge is never briefly wrong. Read from the plan
   * summary rather than from pricingRegion() alone for exactly that reason:
   * both are null before the load, but only one of them also carries the "this
   * has actually been read" fact. A null region inside a loaded summary is the
   * documented fallback to 'IN' — the band the backend itself falls back to.
   */
  protected readonly regionLabel = computed(() => {
    const summary = this.plan();
    if (summary === null) return null;
    return summary.pricingRegion === 'GLOBAL'
      ? 'Billing region: Global · $ USD'
      : 'Billing region: India · ₹ INR';
  });

  /** Explains the badge, which is a statement rather than a control. */
  protected readonly REGION_NOTE =
    'Prices and payment are set for the region this account was first used in, ' +
    'and cannot be changed.';

  /**
   * Whether the one-off top-up packs can be sold to this account, from the
   * price catalogue the order endpoints charge from — the same signal the
   * overlay gates its section on, so the two surfaces cannot disagree about
   * what is for sale. See BillingService.hasTopUpPacks for why this is not a
   * comparison against 'GLOBAL'.
   */
  protected readonly hasTopUpPacks = this.billing.hasTopUpPacks;

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
    this.creditsAdded.emit();
  }

  /** A redeemed promo code lands as credits — same re-read as a top-up. */
  protected onPromoRedeemed(): void {
    this.onCreditsAdded();
  }

  /** An upgrade changes the allowance, so the meter has to be re-read too. */
  protected onUpgraded(): void {
    void this.billing.refreshPlanSummary();
    void this.refreshQuota();
    this.upgraded.emit();
  }

  /**
   * Minor units + currency → "₹499" / "$9" / "—" for a zero amount. The shared
   * formatter, because the picker, the pack buttons and the public pricing
   * section print the same numbers and must agree with this screen. Money is
   * integer minor units end to end.
   */
  protected priceLabel(amountMinor: number, currency: string): string {
    return formatPriceMinor(amountMinor, currency);
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
      // Awaited with the summary so the top-up section is decided before the
      // page draws, rather than appearing after the slab has settled.
      this.billing.ensurePricing(),
    ]);
    this.loading.set(false);
  }

  private async refreshQuota(): Promise<void> {
    this.quota.set(await this.analyze.fetchQuota());
  }
}
