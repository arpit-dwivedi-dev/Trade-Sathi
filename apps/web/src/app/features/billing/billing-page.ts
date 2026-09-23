import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import type { FeatureCreditCost } from '@tradesathi/shared';

import { BetaCredits } from './beta-credits';
import { BillingService } from './billing.service';
import { BuyCreditsButton } from './buy-credits-button';
import { BETA_PROMO_CREDITS, PURCHASES_ENABLED } from './free-beta';
import { PromoRedeemBox } from './promo-redeem-box';

/** Human labels for a feature_key — the closed set in FEATURE_CREDIT_KEYS. */
const FEATURE_LABELS: Readonly<Record<string, string>> = {
  chart_analysis: 'Chart analysis',
  daily_briefing_run: 'Daily briefing',
  fundamental_analysis: 'Fundamental analysis',
};

/**
 * Billing, as one screen: the balance, and both ways to add to it.
 *
 * Deliberately not split into tabs. There is one credit balance now, spent by
 * every paid feature at a centrally configured cost — a plan and a top-up used
 * to be two different answers to "I need more analyses", but there is only one
 * kind of purchase left, so there is nothing left to compare across tabs. The
 * account page keeps no billing surface at all; it is identity only.
 *
 * During the free beta (PURCHASES_ENABLED off) the purchase card says paid
 * credits are coming soon and the redeem card carries the beta code. The
 * purchase flow stays in the template, only not rendered.
 */
@Component({
  selector: 'app-billing-page',
  imports: [BetaCredits, BuyCreditsButton, PromoRedeemBox, ProgressSpinnerModule, RouterLink],
  styleUrl: './billing-page.css',
  templateUrl: './billing-page.html',
})
export class BillingPage implements OnInit {
  private readonly billing = inject(BillingService);

  protected readonly purchasesEnabled = PURCHASES_ENABLED;
  protected readonly betaCredits = BETA_PROMO_CREDITS;

  protected readonly loading = signal(true);

  /**
   * Lets the shell reset any other screen's stale "not enough credits" state
   * once a purchase actually lands.
   */
  readonly creditsAdded = output<void>();

  /** The shared BillingService cache, not a private copy — every consumer of
   * the balance reads the same signal. */
  protected readonly balance = this.billing.creditBalance;

  protected readonly featureCosts = computed<FeatureCreditCost[]>(
    () => this.billing.pricing()?.featureCosts ?? [],
  );

  /**
   * The account's price band, as a display label — or null until pricing has
   * loaded, so the badge is never briefly wrong.
   */
  protected readonly regionLabel = computed(() => {
    const region = this.billing.pricingRegion();
    if (region === null) return null;
    return region === 'GLOBAL' ? 'Billing region: Global · $ USD' : 'Billing region: India · ₹ INR';
  });

  /** Explains the badge, which is a statement rather than a control. */
  protected readonly REGION_NOTE =
    'Prices and payment are set for the region this account was first used in, ' +
    'and cannot be changed.';

  ngOnInit(): void {
    void this.load();
  }

  /**
   * A purchase or a redeemed code only shows up in the balance once the
   * webhook (or the redeem call) has actually landed, so re-read rather than
   * optimistically incrementing — the same reason the purchase flow polls
   * instead of trusting Razorpay's client-side callback.
   */
  protected onCreditsAdded(): void {
    void this.billing.refreshCreditBalance();
    this.creditsAdded.emit();
  }

  /** "1 credit · Chart analysis" — one line per configured feature, so the
   * balance card states every feature's real cost rather than just the
   * first one in the array. */
  protected featureCostLabel(cost: FeatureCreditCost): string {
    const feature = FEATURE_LABELS[cost.featureKey] ?? cost.featureKey;
    return `${cost.credits} credit${cost.credits === 1 ? '' : 's'} · ${feature}`;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    await Promise.all([
      // ensure, not fetch: the shell already loaded this on mount.
      this.billing.ensureCreditBalance(),
      this.billing.ensurePricing(),
    ]);
    this.loading.set(false);
  }
}
