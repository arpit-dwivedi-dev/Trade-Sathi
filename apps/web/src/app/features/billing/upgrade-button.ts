import { Component, OnDestroy, computed, inject, output, signal } from '@angular/core';

import { AuthService } from '../../core/auth.service';
import { BillingService, type SubscriptionPollHandle } from './billing.service';
import { PlanPicker } from './plan-picker';

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
 * The plan cards are rendered directly in the idle state rather than behind a
 * "choose a plan" button of their own: that button added a click and a second
 * modal layer without adding a decision, since picking a card is the decision.
 *
 * Entitlement is never inferred from Razorpay's client-side handler callback;
 * 'success' is only reached once the subscriptions row — written by the webhook
 * handler using the service role — actually reads 'active'.
 */
@Component({
  selector: 'app-upgrade-button',
  imports: [PlanPicker],
  styleUrl: './upgrade-button.css',
  templateUrl: './upgrade-button.html',
})
export class UpgradeButton implements OnDestroy {
  private readonly billing = inject(BillingService);
  private readonly auth = inject(AuthService);

  /** Lets the parent clear whatever state the quota block put it in. */
  readonly upgraded = output<void>();

  /**
   * Passed straight through to the picker so it can mark the user's current
   * tier. Read from the shared BillingService cache rather than fetched here —
   * the nav and the overlay need the same value and must not each query for it.
   */
  protected readonly currentPlanKey = this.billing.currentPlanKey;

  /**
   * Add-ons the user already holds, so the picker can mark them rather than
   * offer them. Read from the same shared cache as currentPlanKey — an add-on
   * is not represented by that key at all (it never occupies the manual-plan
   * slot), so it needs its own channel to the picker.
   */
  protected readonly heldAddOnKeys = this.billing.heldAddOnKeys;

  protected readonly state = signal<UpgradeState>('idle');
  protected readonly error = signal<string | null>(null);

  /**
   * True while money is being taken or confirmed. The overlay above reads this
   * to refuse to close: unmounting mid-flow tears this component down, which
   * cancels the poll that is the only thing telling the user whether the
   * payment they just made actually landed.
   */
  readonly busy = computed(() => {
    const state = this.state();
    return (
      state === 'subscribing' ||
      state === 'loading_checkout' ||
      state === 'checkout_open' ||
      state === 'confirming'
    );
  });

  private poll: SubscriptionPollHandle | null = null;

  protected async onPlanSelected(planKey: string): Promise<void> {
    // Same disabled-during-flight rule chart-drop uses: a click in any other
    // state is ignored outright rather than restarting the flow.
    if (this.state() !== 'idle') return;

    this.error.set(null);
    this.state.set('subscribing');

    const subscribed = await this.billing.subscribe(planKey);
    if (!subscribed.ok) {
      if (subscribed.reason === 'already_subscribed') {
        // Reaching here now means the cached plan summary was stale — a live
        // subscription exists that the picker didn't know to mark. Re-read it
        // so the cards correct themselves instead of leaving the user staring
        // at a Choose button the backend will keep refusing.
        //
        // Known MVP limitation: the 409 does not carry the existing
        // subscriptionId, so there is nothing to reopen Checkout with. Resuming
        // an in-flight subscription is separate future work, not solved here.
        void this.billing.refreshPlanSummary();
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

  /**
   * Back to the cards. Needed because the cards *are* the idle state now — with
   * no entry button to click again, an error would otherwise be a dead end.
   */
  protected onRetry(): void {
    this.error.set(null);
    this.state.set('idle');
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
