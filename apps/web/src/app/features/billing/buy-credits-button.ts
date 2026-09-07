import { Component, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AuthService } from '../../core/auth.service';
import { BillingService, type CreditPackKind, type CreditPollHandle } from './billing.service';

type BuyCreditsState =
  | 'idle'
  | 'ordering'
  | 'loading_checkout'
  | 'checkout_open'
  | 'confirming'
  | 'success'
  // Listed for completeness, never entered: a dismissed Checkout returns the
  // component straight to 'idle', because nothing actually went wrong.
  | 'dismissed'
  | 'confirming_slow'
  | 'poll_error'
  | 'error';

/**
 * Drives the order → Checkout → confirm-by-polling flow for a credit pack.
 *
 * The same discipline as UpgradeButton: credits are never inferred from
 * Razorpay's client-side handler callback. 'success' is only reached once the
 * payments row — written by the webhook handler using the service role — reads
 * 'captured', which is also the only thing that moves credit_balance.
 */
@Component({
  selector: 'app-buy-credits-button',
  imports: [ButtonModule, ProgressSpinnerModule],
  styleUrl: './upgrade-button.css',
  templateUrl: './buy-credits-button.html',
})
export class BuyCreditsButton implements OnDestroy {
  private readonly billing = inject(BillingService);
  private readonly auth = inject(AuthService);

  /**
   * Which credit currency this button tops up. Parameterised rather than
   * copied into a second component: the order → Checkout → poll flow, and the
   * discipline that credits are never inferred from Razorpay's client-side
   * callback, are identical for both packs. Only the label and the endpoint
   * differ.
   */
  readonly kind = input<CreditPackKind>('analysis');

  /** Lets the parent clear whatever state the quota block put it in. */
  readonly creditsAdded = output<void>();

  /** Pack copy, kept beside the kind so the two cannot drift apart. */
  protected readonly buyLabel = computed(() =>
    this.kind() === 'daily_briefing'
      ? 'Buy 10 more briefings — ₹99'
      : 'Buy 10 more analyses — ₹79',
  );
  protected readonly successLabel = computed(() =>
    this.kind() === 'daily_briefing'
      ? "10 briefings added. They'll be used once this month's allowance runs out."
      : "10 analyses added. You're good to go.",
  );

  protected readonly state = signal<BuyCreditsState>('idle');
  protected readonly error = signal<string | null>(null);

  /** True while money is being taken or confirmed — see UpgradeButton.busy. */
  readonly busy = computed(() => {
    const state = this.state();
    return (
      state === 'ordering' ||
      state === 'loading_checkout' ||
      state === 'checkout_open' ||
      state === 'confirming'
    );
  });

  private poll: CreditPollHandle | null = null;

  protected async onBuyClick(): Promise<void> {
    // Same disabled-during-flight rule as UpgradeButton: a click in any other
    // state is ignored outright rather than starting a second order.
    if (this.state() !== 'idle') return;

    this.error.set(null);
    this.state.set('ordering');

    const order = await this.billing.buyCredits(this.kind());
    if (!order.ok) {
      this.error.set(order.message);
      this.state.set('error');
      return;
    }

    this.state.set('loading_checkout');
    try {
      await this.billing.loadCheckoutScript();
    } catch (cause) {
      console.warn('Razorpay Checkout script failed to load', cause);
      this.error.set(
        "Couldn't load the payment window. Check your connection or an ad blocker, then try again.",
      );
      this.state.set('error');
      return;
    }

    this.state.set('checkout_open');
    let checkout;
    try {
      checkout = await this.billing.openCreditCheckout(
        order.orderId,
        order.keyId,
        order.amountMinor,
        this.auth.user()?.email ?? null,
      );
    } catch (cause) {
      console.warn('Razorpay Checkout could not be opened', cause);
      this.error.set("Couldn't open the payment window. Please try again.");
      this.state.set('error');
      return;
    }

    if (checkout.outcome === 'dismissed') {
      // The user simply changed their mind. Returning cleanly to idle — not to
      // an error state — is the point: nothing went wrong. The Razorpay Order
      // and its 'created' payments row are left behind deliberately; they are
      // inert until a webhook captures them, exactly like an abandoned
      // subscription checkout.
      this.state.set('idle');
      return;
    }

    this.state.set('confirming');
    this.startPolling(order.orderId);
  }

  private startPolling(orderId: string): void {
    const handle = this.billing.pollCreditPurchase(orderId);
    this.poll = handle;

    void handle.result.then((outcome) => {
      this.poll = null;

      switch (outcome) {
        case 'captured':
          this.state.set('success');
          this.creditsAdded.emit();
          break;
        case 'timed_out':
          this.state.set('confirming_slow');
          break;
        case 'poll_error':
          this.error.set("Couldn't confirm your purchase — please refresh.");
          this.state.set('poll_error');
          break;
      }
    });
  }

  ngOnDestroy(): void {
    // Without this the setInterval keeps firing after the user navigates away,
    // and would try to update a destroyed component's state.
    this.poll?.cancel();
    this.poll = null;
  }
}
