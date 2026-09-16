import { Component, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AuthService } from '../../core/auth.service';
import {
  BillingService,
  formatPriceMinor,
  type CreditPackKind,
  type CreditPollHandle,
} from './billing.service';

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
  | 'used_up'
  | 'poll_error'
  | 'error';

/**
 * Drives the order → Checkout → confirm-by-polling flow for a credit pack.
 *
 * The same discipline as UpgradeButton: credits are never inferred from
 * Razorpay's client-side handler callback. 'success' is only reached once the
 * payments row — written by the webhook handler using the service role — reads
 * 'captured', which is also the only thing that moves credit_balance.
 *
 * 'used_up' is entry-pass only: the pass is once per account, and a 409 from
 * the backend is the answer "you already used it", not an error.
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
   * callback, are identical for all packs. Only the labels differ.
   */
  readonly kind = input<CreditPackKind>('analysis');

  /** Lets the parent clear whatever state the quota block put it in. */
  readonly creditsAdded = output<void>();

  /**
   * This pack's price and grant in the account's region, or null while the
   * price list hasn't arrived. The entry pass is published separately by the
   * endpoint — it is a one-time purchase rather than a top-up, so it is not in
   * the top-up list.
   */
  private readonly packPrice = computed<{
    amountMinor: number;
    currency: string;
    credits: number;
  } | null>(() => {
    if (this.kind() === 'entry_pass') {
      const pass = this.billing.entryPassPrice();
      return pass
        ? { amountMinor: pass.amountMinor, currency: pass.currency, credits: pass.credits }
        : null;
    }
    return this.billing.topUpPacks().find((pack) => pack.kind === this.kind()) ?? null;
  });

  /**
   * Pack copy, kept beside the kind so the two cannot drift apart.
   *
   * The amount is the server's, read from the same catalogue the order
   * endpoint prices from: the figure a button advertises has to be the figure
   * Checkout charges. Hardcoding it was wrong twice over — once for a GLOBAL
   * account, whose Checkout opens in dollars while the label said ₹49, and
   * again the day the catalogue is repriced. While the price list hasn't
   * resolved the pack is named with no amount at all: a missing figure is
   * honest, another region's figure is not.
   */
  protected readonly buyLabel = computed(() => {
    const kind = this.kind();
    const price = this.packPrice();

    if (kind === 'entry_pass') {
      return price
        ? `Entry pass — ${formatPriceMinor(price.amountMinor, price.currency)}`
        : 'Entry pass';
    }

    const noun = kind === 'daily_briefing' ? 'briefings' : 'analyses';
    if (!price) return `Buy more ${noun}`;
    return `Buy ${price.credits} more ${noun} — ${formatPriceMinor(price.amountMinor, price.currency)}`;
  });
  protected readonly successLabel = computed(() =>
    this.kind() === 'entry_pass'
      ? '5 analyses added. Welcome in.'
      : this.kind() === 'daily_briefing'
        ? "10 briefings added. They'll be used once this month's allowance runs out."
        : "10 analyses added. You're good to go.",
  );

  /**
   * The entry pass is once per account. When the plan summary says it is spent,
   * the button is replaced by the same note the backend's 409 produces — so the
   * offer isn't made a second time to the only users who can hit that 409.
   */
  protected readonly isEntryPassUsed = computed(
    () => this.kind() === 'entry_pass' && this.billing.entryPassUsed(),
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

  /** What Checkout calls the purchase, and the pack's price for this region. */
  private checkoutDescription(): string {
    if (this.kind() === 'entry_pass') return 'Entry pass — 5 analyses';
    if (this.kind() === 'daily_briefing') return '10 briefing credits';
    return '10 analysis credits';
  }

  protected async onBuyClick(): Promise<void> {
    // Same disabled-during-flight rule as UpgradeButton: a click in any other
    // state is ignored outright rather than starting a second order.
    if (this.state() !== 'idle') return;

    this.error.set(null);
    this.state.set('ordering');

    const order = await this.billing.buyCredits(this.kind());
    if (!order.ok) {
      if (order.reason === 'already_purchased') {
        this.state.set('used_up');
        return;
      }
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
        order.currency,
        this.checkoutDescription(),
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
