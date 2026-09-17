import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AuthService } from '../../core/auth.service';
import { BillingService, formatPriceMinor, type CreditPollHandle } from './billing.service';

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

/** The region's purchase bounds, straight from the pricing config. */
interface PurchaseRules {
  min: number;
  /**
   * Null when the region has no configured ceiling — either because it really
   * has none, or because the config predates the bounds columns. Both mean the
   * same thing to this form: bounded below, unbounded above.
   */
  max: number | null;
  step: number;
}

/**
 * Snaps a quantity onto the region's grid and clamps it into range.
 *
 * Counted from the minimum rather than from zero, because that is the grid
 * the backend validates against: (quantity - min) % step === 0.
 *
 * Rounds to the *nearest* step instead of flooring, so a typed 27 with a step
 * of 5 settles on 25 — flooring would turn a near-miss into a jump of a whole
 * step away from what the user typed. Values outside the range clamp rather
 * than wrap, so neither 0 nor a hand-edited megabyte of digits can produce an
 * order the backend will reject.
 */
function snapToRules(value: number, rules: PurchaseRules): number {
  if (!Number.isFinite(value)) return rules.min;
  const stepped = rules.min + Math.round((value - rules.min) / rules.step) * rules.step;
  const clamped = Math.max(rules.min, stepped);
  return rules.max === null ? clamped : Math.min(rules.max, clamped);
}

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
 * Drives the order → Checkout → confirm-by-polling flow for a chosen quantity
 * of credits, at the account's region rate, with an optional promo code.
 *
 * Credits are never inferred from Razorpay's client-side handler callback.
 * 'success' is only reached once the payments row — written server-side with
 * the service role — reads 'captured', which is also the only thing that
 * moves credit_balance.
 *
 * That row is written by the webhook, and failing over to a direct query
 * against Razorpay when it does not arrive is what ends the wait: see
 * reconcile(). The client's own callback still proves nothing, so it only ever
 * triggers the check, never the conclusion.
 */
@Component({
  selector: 'app-buy-credits-button',
  imports: [ButtonModule, ProgressSpinnerModule],
  styleUrl: './buy-credits-button.css',
  templateUrl: './buy-credits-button.html',
})
export class BuyCreditsButton implements OnDestroy {
  private readonly billing = inject(BillingService);
  private readonly auth = inject(AuthService);

  /** Only needed to hand afterNextRender an injection context from a click handler. */
  private readonly injector = inject(Injector);

  /** The promo field, once the disclosure above it has put it in the DOM. */
  private readonly promoInput = viewChild<ElementRef<HTMLInputElement>>('promoInput');

  /** The quantity field, so a committed value can be written back into it. */
  private readonly qtyInput = viewChild<ElementRef<HTMLInputElement>>('qtyInput');

  /** Lets the parent clear whatever state a "not enough credits" block put it in. */
  readonly creditsAdded = output<void>();

  /** The region's price list, or null while it hasn't loaded yet. */
  private readonly pricing = this.billing.pricing;

  /**
   * What is in the quantity field. Deliberately the *raw* value: it can be
   * momentarily out of range or off the grid while the user is mid-edit, and
   * snapping it back on every keystroke would fight them — typing "3" on the
   * way to "35" must not jump the field to the minimum.
   *
   * Everything that orders or prices reads orderQuantity() instead.
   */
  protected readonly quantity = signal<number | null>(null);

  protected readonly promoCode = signal('');

  /** Whether the promo field is showing. Collapsed by default — see the template. */
  protected readonly promoOpen = signal(false);

  /** The region's purchase bounds, or null while pricing hasn't loaded. */
  protected readonly rules = computed<PurchaseRules | null>(() => {
    const pricing = this.pricing()?.pricing;
    if (!pricing) return null;

    // Every field is re-checked rather than trusted: the shared type says these
    // are always present, but a deploy where the web bundle is newer than the
    // API (or than the migration that added the bounds columns) serves a
    // payload without them. Undefined reaching the arithmetic below does not
    // fail loudly — it renders "₹NaN" and a "Buy NaN credits" button, which is
    // how this was found. A missing min is fatal to the form; a missing step or
    // max is not, so those degrade to the old behaviour instead.
    const min = pricing.minPurchaseCredits;
    if (!Number.isFinite(min) || min <= 0) return null;

    const configuredStep = pricing.purchaseIncrementCredits;
    const step = Number.isFinite(configuredStep) && configuredStep > 0 ? configuredStep : 1;

    const configuredMax = pricing.maxPurchaseCredits;
    const max = Number.isFinite(configuredMax) && configuredMax >= min ? configuredMax : null;

    return { min, max, step };
  });

  protected readonly minQuantity = computed(() => this.rules()?.min ?? null);
  protected readonly maxQuantity = computed(() => this.rules()?.max ?? null);

  /**
   * The quantity that will actually be ordered: the typed value snapped onto
   * the region's grid and clamped into its range.
   *
   * This is the single place the form's arbitrary input becomes a valid
   * quantity, so the label, the price, the stepper's limits and the order
   * itself can never disagree about what is being bought.
   *
   * A null is "pricing has not loaded", never "the field is empty". An empty
   * field means the minimum — the same thing it settles on at blur and on
   * submit — because treating it as nothing to buy would leave the stepper
   * dead-ended the moment someone cleared the field to retype it.
   */
  protected readonly orderQuantity = computed<number | null>(() => {
    const rules = this.rules();
    if (!rules) return null;
    return snapToRules(this.quantity() ?? rules.min, rules);
  });

  protected readonly canStepDown = computed(() => {
    const rules = this.rules();
    const quantity = this.orderQuantity();
    return rules !== null && quantity !== null && quantity > rules.min;
  });

  protected readonly canStepUp = computed(() => {
    const rules = this.rules();
    const quantity = this.orderQuantity();
    return rules !== null && quantity !== null && (rules.max === null || quantity < rules.max);
  });

  /**
   * The quick-select amounts as credit counts, so the buttons can show the
   * quantity rather than just an amount. Same math the backend uses to price
   * a quantity: amount ÷ price-per-credit, rounded down.
   *
   * Snapped and de-duplicated through the same rules the field uses: the
   * amounts are config, and a chip that offered a quantity the backend would
   * refuse is exactly the drift the rules exist to prevent.
   */
  protected readonly quickOptions = computed<{ amountMinor: number; credits: number }[]>(() => {
    const pricing = this.pricing()?.pricing;
    const rules = this.rules();
    if (!pricing || !rules) return [];

    const seen = new Set<number>();
    const options: { amountMinor: number; credits: number }[] = [];
    for (const amountMinor of pricing.quickAmountsMinor) {
      const credits = snapToRules(Math.floor(amountMinor / pricing.pricePerCreditMinor), rules);
      if (seen.has(credits)) continue;
      seen.add(credits);
      options.push({ amountMinor, credits });
    }
    return options;
  });

  /** The amount this account will actually be charged for the chosen quantity. */
  protected readonly estimatedAmountMinor = computed<number | null>(() => {
    const pricing = this.pricing()?.pricing;
    const quantity = this.orderQuantity();
    if (!pricing || quantity === null) return null;
    return quantity * pricing.pricePerCreditMinor;
  });

  protected readonly estimatedCostLabel = computed(() => {
    const pricing = this.pricing()?.pricing;
    const amount = this.estimatedAmountMinor();
    if (!pricing || amount === null) return null;
    return formatPriceMinor(amount, pricing.currency);
  });

  /** The action, without the price — that is the total row's job now, and
   * repeating it here only made the two figures compete. */
  protected readonly buyLabel = computed(() => {
    const quantity = this.orderQuantity();
    if (quantity === null) return 'Buy credits';
    return `Buy ${quantity} credit${quantity === 1 ? '' : 's'}`;
  });

  protected readonly state = signal<BuyCreditsState>('idle');
  protected readonly error = signal<string | null>(null);

  /** True while money is being taken or confirmed. */
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
    // Defaults the quantity to the region minimum once pricing resolves, but
    // only until the user has typed something — an effect that kept
    // overwriting a manual entry every time pricing() re-fired would fight
    // the input.
    afterNextRender(() => {
      void this.billing.ensurePricing().then((overview) => {
        if (overview && this.quantity() === null) {
          this.quantity.set(overview.pricing.minPurchaseCredits);
        }
      });
      // Deferred to after the first render rather than done in ngOnInit. The
      // fact being read — a remembered order — lives in localStorage, so the
      // server cannot know it, and deciding it during the first render would
      // have the client's markup disagree with the server's. Hydration treats
      // that as an error, and the repo's existing browser-only initialisation
      // (chart-drop's camera) defers the same way.
      this.resumePendingPurchase();
    });
  }

  /**
   * Picks up a purchase that was still being confirmed when the page went away.
   *
   * Resumed rather than re-offered because the user has already been to
   * Checkout: their money may already be gone.
   */
  private resumePendingPurchase(): void {
    const pending = this.billing.readPendingCreditOrder();
    if (pending === null) return;

    this.state.set('confirming');
    // Checked straight away rather than on the usual delay — a reload means
    // real time has passed since Checkout, so there is no reason to sit through
    // the grace period that exists to give a webhook still in flight.
    void this.reconcile(pending);
    this.startPolling(pending);
  }

  /**
   * Snaps and clamps a value, stores it, and writes the canonical form back
   * into the field.
   *
   * The write-back is not cosmetic: the input is bound one-way, so when the
   * committed value equals the one already held (typing 27 with a step of 5
   * settles on 25, again and again) Angular sees no change and leaves the
   * stale text on screen. Without this the user would be looking at 27 while
   * the form priced and ordered 25.
   */
  private commit(value: number): void {
    const rules = this.rules();
    if (!rules) return;

    const canonical = snapToRules(value, rules);
    this.quantity.set(canonical);

    const input = this.qtyInput()?.nativeElement;
    if (input) input.value = String(canonical);
  }

  /**
   * Takes the field as typed and holds it. Out-of-range values are kept
   * rather than corrected here — orderQuantity() is what makes them safe, and
   * correcting mid-keystroke is what makes a quantity field feel broken.
   *
   * An empty field (which is also how a number input reports letters it
   * refuses to accept) is the user mid-edit, not an instruction, so the
   * committed quantity is left alone.
   */
  protected onQuantityInput(value: string): void {
    const trimmed = value.trim();
    if (trimmed === '') return;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;

    this.quantity.set(parsed);
  }

  /** Settles the field onto a valid quantity once the user has stopped typing. */
  protected onQuantityBlur(): void {
    this.commit(this.orderQuantity() ?? 1);
  }

  protected selectQuick(credits: number): void {
    this.commit(credits);
  }

  /** Nudges the quantity by one step, clamped into range by commit(). */
  protected stepQuantity(direction: 1 | -1): void {
    const rules = this.rules();
    if (!rules) return;
    this.commit((this.orderQuantity() ?? rules.min) + direction * rules.step);
  }

  protected isQuickSelected(credits: number): boolean {
    return this.orderQuantity() === credits;
  }

  /**
   * Reveals the promo field and moves focus into it.
   *
   * Focused after the next render rather than here: the input does not exist
   * until the signal above has been rendered, and a promo field the user has
   * to click a second time is the whole thing this disclosure was meant to
   * avoid.
   */
  protected openPromo(): void {
    this.promoOpen.set(true);
    afterNextRender(() => this.promoInput()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /** Collapses the field and drops the code with it — the two are one control,
   * so a hidden field must not still be carrying a discount into the order. */
  protected closePromo(): void {
    this.promoOpen.set(false);
    this.promoCode.set('');
  }

  protected async onBuyClick(): Promise<void> {
    // Same disabled-during-flight rule as elsewhere: a click in any other
    // state is ignored outright rather than starting a second order.
    if (this.state() !== 'idle') return;

    // The canonical quantity, never the raw field: whatever the user left
    // typed, what gets ordered is what the label and the total have been
    // showing, and what the backend will accept.
    const quantity = this.orderQuantity();
    if (quantity === null) return;

    // Settles the field onto what is about to be ordered, so the order and
    // the screen agree while the checkout window is open.
    this.commit(quantity);

    this.error.set(null);
    this.state.set('ordering');

    const code = this.promoCode().trim();
    const order = await this.billing.purchaseCredits(quantity, code.length > 0 ? code : undefined);
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
        order.currency,
        `${order.creditsRequested} credits`,
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
      // inert until a webhook captures them.
      this.state.set('idle');
      return;
    }

    this.state.set('confirming');
    // Remembered here rather than once the poll succeeds: the reload this
    // exists for can happen at any moment from now on, including during the
    // seconds the webhook is still in flight.
    this.billing.rememberPendingCreditOrder(order.orderId);
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
    this.billing.forgetPendingCreditOrder();
    this.state.set('success');
    void this.billing.refreshCreditBalance();
    this.creditsAdded.emit();
  }

  /**
   * A second look, offered after the first one gave up. Safe to repeat: the
   * backend answers from the payments row without touching the provider when
   * the purchase has already been applied, and the grant itself is idempotent.
   */
  protected onCheckAgain(): void {
    const orderId = this.billing.readPendingCreditOrder();
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
