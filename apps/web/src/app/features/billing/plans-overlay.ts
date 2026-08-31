import { Component, HostListener, OnInit, inject, output, signal } from '@angular/core';

import { BillingService } from './billing.service';
import { BuyCreditsButton } from './buy-credits-button';
import { UpgradeButton } from './upgrade-button';

/**
 * The one place plans and credits are offered from. Both entry points — the
 * nav control and the analyze page's quota block — open this same component,
 * so there is no second arrangement of these buttons to keep in sync.
 *
 * It arranges existing pieces and owns no purchase logic of its own:
 * UpgradeButton and BuyCreditsButton are mounted unchanged, each keeping its
 * own state machine, polling and ngOnDestroy cancellation. Closing the overlay
 * unmounts them, which is exactly the teardown they already handle.
 *
 * DELIBERATELY NOT a <dialog>.showModal(). A modal dialog is promoted to the
 * browser's top layer, which paints above every z-index on the page — including
 * Razorpay Checkout's. That put Checkout *behind* this panel and made it
 * impossible to pay. A plain fixed-position layer at a modest z-index keeps the
 * normal stacking rules, so Checkout's own (very high) z-index wins and it
 * opens above us, which is what the purchase flow needs.
 *
 * The cost of leaving the top layer is that the focus trap and Esc handling
 * <dialog> provided for free are now ours: Esc is handled below.
 */
@Component({
  selector: 'app-plans-overlay',
  imports: [UpgradeButton, BuyCreditsButton],
  styleUrl: './plans-overlay.css',
  templateUrl: './plans-overlay.html',
})
export class PlansOverlay implements OnInit {
  private readonly billing = inject(BillingService);

  readonly closed = output<void>();
  /** Forwarded from the mounted UpgradeButton, unchanged. */
  readonly upgraded = output<void>();
  /** Forwarded from the mounted BuyCreditsButton, unchanged. */
  readonly creditsAdded = output<void>();

  /** The shared cached read — not a query of its own. */
  protected readonly plan = this.billing.currentPlan;
  protected readonly loading = signal(true);

  ngOnInit(): void {
    void this.billing.ensurePlanSummary().finally(() => this.loading.set(false));
  }

  /**
   * Replaces what <dialog> did for free. Bound on the document rather than the
   * panel so it fires wherever focus happens to be.
   *
   * Razorpay Checkout runs in its own iframe, so key events inside it never
   * reach this listener — pressing Esc over Checkout closes Checkout, not this.
   */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close();
  }

  /**
   * Whether to show the monthly-plans section at all. Shown for every user,
   * not just free-plan ones: it now also carries independent add-ons (e.g.
   * 'daily_briefing_monthly') that are purchasable regardless of manual tier.
   * PlanPicker.isChoosable() is what actually prevents switching between
   * manual tiers — that restriction lives there, not here.
   */
  protected canUpgrade(): boolean {
    return true;
  }

  protected planLabel(): string {
    return this.plan()?.name ?? 'Unknown';
  }

  protected close(): void {
    this.closed.emit();
  }

  /** Only a click on the backdrop itself dismisses; clicks inside the panel don't. */
  protected onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  /**
   * The plan just changed, so the cached tier is stale — refresh it before
   * telling the parent, or a reopened overlay would still show the old plan.
   */
  protected onUpgraded(): void {
    void this.billing.refreshPlanSummary();
    this.upgraded.emit();
  }

  protected onCreditsAdded(): void {
    this.creditsAdded.emit();
  }
}
