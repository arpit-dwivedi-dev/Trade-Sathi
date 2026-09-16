import {
  Component,
  OnDestroy,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AuthService } from '../../core/auth.service';
import {
  BillingService,
  formatPriceMinor,
  type CreditPackKind,
  type CreditPollHandle,
} from './billing.service';

/**
 * How long to wait on the webhook before asking the backend to check the order
 * with Razorpay directly.
 *
 * The webhook is the fast path and normally lands within seconds, so this only
 * fires when it has not. Short enough that a local dev session — where the
 * webhook has no route to the server at all — does not sit through the full
 * poll timeout before confirming, long enough that a merely slow delivery is
 * usually still resolved by the cheaper path.
 */
const RECONCILE_AFTER_MS = 12_000;

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
 * payments row — written server-side with the service role — reads 'captured',
 * which is also the only thing that moves credit_balance.
 *
 * That row is written by the webhook, and failing over to a direct query
 * against Razorpay when it does not arrive is what ends the wait: see
 * reconcile(). The client's own callback still proves nothing, so it only ever
 * triggers the check, never the conclusion.
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

  /**
   * The single delayed "has the webhook arrived yet?" check. Held so it can be
   * cleared when the purchase settles by any other route — a timer firing
   * against a purchase that is already resolved would ask again for nothing.
   */
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Deferred to after the first render rather than done in ngOnInit. The
    // fact being read — a remembered order — lives in localStorage, so the
    // server cannot know it, and deciding it during the first render would have
    // the client's markup disagree with the server's. Hydration treats that as
    // an error, and the repo's existing browser-only initialisation
    // (chart-drop's camera) defers the same way.
    afterNextRender(() => this.resumePendingPurchase());
  }

  /**
   * Picks up a purchase that was still being confirmed when the page went away.
   *
   * Resumed rather than re-offered because the user has already been to
   * Checkout: their money may already be gone, and for the entry pass a second
   * order would be a second charge.
   */
  private resumePendingPurchase(): void {
    const pending = this.billing.readPendingCreditOrder(this.kind());
    if (pending === null) return;

    this.state.set('confirming');
    // Checked straight away rather than on the usual delay — a reload means
    // real time has passed since Checkout, so there is no reason to sit through
    // the grace period that exists to give a webhook still in flight.
    void this.reconcile(pending);
    this.startPolling(pending);
  }

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
        this.billing.forgetPendingCreditOrder(this.kind());
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
    // Remembered here rather than once the poll succeeds: the reload this
    // exists for can happen at any moment from now on, including during the
    // seconds the webhook is still in flight.
    this.billing.rememberPendingCreditOrder(order.orderId, this.kind());
    this.startPolling(order.orderId);
  }

  private startPolling(orderId: string): void {
    const handle = this.billing.pollCreditPurchase(orderId);
    this.poll = handle;

    // The fast path is the webhook, which writes the payments row the poll
    // reads. This is the fallback for it never arriving — which, against a
    // local dev server, it never does: Razorpay has no route to one. Without
    // this the only possible outcome there would be the full-timeout wait.
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile(orderId);
    }, RECONCILE_AFTER_MS);

    void handle.result.then((outcome) => {
      this.poll = null;

      switch (outcome) {
        case 'captured':
          this.settleAsPurchased();
          break;
        case 'timed_out':
          // Last chance to establish it ourselves before telling the user we
          // could not. 'timed_out' is not a failed payment — it is only the
          // end of our patience for the webhook.
          void this.reconcile(orderId, true);
          break;
        case 'poll_error':
          // The marker survives: the user is about to be told to refresh, and
          // refreshing into a resumed check is exactly what should happen to a
          // purchase that may well have gone through.
          this.error.set("Couldn't confirm your purchase — please refresh.");
          this.state.set('poll_error');
          break;
      }
    });
  }

  /**
   * Asks the backend to ask Razorpay whether this order is paid.
   *
   * `isFinal` marks the call made after the poll has already given up, where a
   * "not paid yet" answer has to be shown to the user rather than quietly
   * waited on.
   */
  private async reconcile(orderId: string, isFinal = false): Promise<void> {
    // Nothing to ask about if the purchase settled while this was queued: the
    // poll may have succeeded, or the user may have started over.
    if (this.state() !== 'confirming') return;

    const outcome = await this.billing.reconcileCreditOrder(orderId);

    // Re-checked after the await: the poll runs on its own timer and could have
    // settled the purchase while this request was in flight.
    if (this.state() !== 'confirming') return;

    if (outcome === 'captured') {
      this.settleAsPurchased();
      return;
    }

    if (isFinal) {
      this.state.set('confirming_slow');
    }
  }

  private settleAsPurchased(): void {
    // Guarded rather than assumed unique: the poll and the reconciliation can
    // both discover the same capture, and only one of them should be the one
    // that reports it.
    if (this.state() !== 'confirming') return;

    this.cancelInFlight();
    this.billing.forgetPendingCreditOrder(this.kind());
    this.state.set('success');
    this.creditsAdded.emit();
  }

  /**
   * A second look, offered after the first one gave up. Safe to repeat: the
   * backend answers from the payments row without touching the provider when
   * the purchase has already been applied, and the grant itself is idempotent.
   */
  protected onCheckAgain(): void {
    const orderId = this.billing.readPendingCreditOrder(this.kind());
    if (orderId === null) {
      // The remembered order is what carries the id across states, and it has
      // aged out or been cleared. There is genuinely nothing left to check.
      this.state.set('idle');
      return;
    }

    this.state.set('confirming');
    void this.reconcile(orderId);
    this.startPolling(orderId);
  }

  private cancelInFlight(): void {
    this.poll?.cancel();
    this.poll = null;

    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  ngOnDestroy(): void {
    // Without this the setInterval keeps firing after the user navigates away,
    // and would try to update a destroyed component's state. The delayed
    // reconciliation is cleared for the same reason.
    this.cancelInFlight();
  }
}
