import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  afterNextRender,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AppIcon } from '../../shared/icons/app-icon';
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
 * <dialog> provided for free are now ours: Esc is handled below, and the
 * focus trap comes from cdkTrapFocus (@angular/cdk/a11y) — a standalone
 * directive with no CDK Overlay/z-index involvement, so it doesn't touch the
 * stacking approach above.
 */
@Component({
  selector: 'app-plans-overlay',
  imports: [
    A11yModule,
    ButtonModule,
    AppIcon,
    ProgressSpinnerModule,
    UpgradeButton,
    BuyCreditsButton,
  ],
  styleUrl: './plans-overlay.css',
  templateUrl: './plans-overlay.html',
})
export class PlansOverlay implements OnInit, OnDestroy {
  private readonly billing = inject(BillingService);
  private readonly document = inject(DOCUMENT);

  readonly closed = output<void>();
  /** Forwarded from the mounted UpgradeButton, unchanged. */
  readonly upgraded = output<void>();
  /** Forwarded from the mounted BuyCreditsButton, unchanged. */
  readonly creditsAdded = output<void>();

  /** The shared cached read — not a query of its own. */
  protected readonly plan = this.billing.currentPlan;
  protected readonly loading = signal(true);

  private readonly upgrade = viewChild(UpgradeButton);
  private readonly credits = viewChild(BuyCreditsButton);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  /** The page's own overflow, restored on close. */
  private previousOverflow: string | null = null;

  constructor() {
    // Focus has to enter the dialog for Esc and Tab to behave as a dialog's
    // should; without this it stayed on whatever opened the overlay, behind
    // the scrim.
    afterNextRender(() => this.panel()?.nativeElement.focus());
  }

  /**
   * True while either mounted purchase flow is taking or confirming money.
   *
   * Closing unmounts those components, and their ngOnDestroy cancels the poll
   * that confirms the webhook landed — so an Esc keypress or a stray backdrop
   * click during confirmation left a user who had genuinely paid with no
   * indication that anything had happened.
   */
  protected purchaseInFlight(): boolean {
    return this.upgrade()?.busy() === true || this.credits()?.busy() === true;
  }

  ngOnInit(): void {
    void this.billing.ensurePlanSummary().finally(() => this.loading.set(false));

    // The page behind a fixed scrim still scrolls, so a scroll gesture over
    // the overlay moved the content underneath it instead of the panel.
    const body = this.document.body;
    this.previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
  }

  ngOnDestroy(): void {
    this.document.body.style.overflow = this.previousOverflow ?? '';
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

  /**
   * Dismisses the overlay unless a purchase is mid-flight — see
   * purchaseInFlight. The explicit close button is bound to this too: there is
   * no dismissal route that should be able to discard a payment in progress.
   */
  protected close(): void {
    if (this.purchaseInFlight()) return;
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
