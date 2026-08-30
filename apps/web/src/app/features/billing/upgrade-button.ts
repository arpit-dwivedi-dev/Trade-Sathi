import { Component, OnDestroy, inject, output, signal } from '@angular/core';

import { AuthService } from '../../core/auth.service';
import { BillingService, type SubscriptionPollHandle } from './billing.service';

type UpgradeState =
  | 'idle'
  | 'subscribing'
  | 'loading_checkout'
  | 'checkout_open'
  | 'confirming'
  | 'success'
  // Listed for completeness, never entered: a dismissed Checkout returns the
  // component straight to 'idle', because nothing actually went wrong.
  | 'dismissed'
  | 'already_subscribed'
  | 'confirming_slow'
  | 'error';

/**
 * Drives the subscribe → Checkout → confirm-by-polling flow.
 *
 * Entitlement is never inferred from Razorpay's client-side handler callback;
 * 'success' is only reached once the subscriptions row — written by the webhook
 * handler using the service role — actually reads 'active'.
 */
@Component({
  selector: 'app-upgrade-button',
  styleUrl: './upgrade-button.css',
  templateUrl: './upgrade-button.html',
})
export class UpgradeButton implements OnDestroy {
  private readonly billing = inject(BillingService);
  private readonly auth = inject(AuthService);

  /** Lets the parent clear whatever state the quota block put it in. */
  readonly upgraded = output<void>();

  protected readonly state = signal<UpgradeState>('idle');
  protected readonly error = signal<string | null>(null);

  private poll: SubscriptionPollHandle | null = null;

  protected async onUpgradeClick(): Promise<void> {
    // Same disabled-during-flight rule chart-drop uses: a click in any other
    // state is ignored outright rather than restarting the flow.
    if (this.state() !== 'idle') return;

    this.error.set(null);
    this.state.set('subscribing');

    const subscribed = await this.billing.subscribe();
    if (!subscribed.ok) {
      if (subscribed.reason === 'already_subscribed') {
        // Known MVP limitation: the 409 does not carry the existing
        // subscriptionId, so there is nothing to reopen Checkout with. Resuming
        // an in-flight subscription is separate future work, not solved here.
        this.state.set('already_subscribed');
        return;
      }
      this.error.set(subscribed.message);
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
      checkout = await this.billing.openCheckout(
        subscribed.subscriptionId,
        subscribed.keyId,
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
      // an error state — is the point: nothing went wrong.
      this.state.set('idle');
      return;
    }

    this.state.set('confirming');
    this.startPolling(subscribed.subscriptionId);
  }

  private startPolling(subscriptionId: string): void {
    const handle = this.billing.pollSubscriptionStatus(subscriptionId);
    this.poll = handle;

    void handle.result.then((outcome) => {
      this.poll = null;

      switch (outcome) {
        case 'active':
          this.state.set('success');
          this.upgraded.emit();
          break;
        case 'timed_out':
          this.state.set('confirming_slow');
          break;
        case 'poll_error':
          this.error.set("Couldn't confirm your subscription status — please refresh.");
          this.state.set('error');
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
