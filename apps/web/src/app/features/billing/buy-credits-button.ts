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
import { DomSanitizer, type SafeUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import type { UpiOrder, UpiPaymentInstructions } from '@tradesathi/shared';

import { BillingService, formatPriceMinor } from './billing.service';

/** How often the order is asked about while its QR is live, and after. */
const POLL_LIVE_MS = 3000;
const POLL_LATE_MS = 5000;

/** Exact rupees and paise: the paise are what identify the order, so never rounded away. */
export function formatExactRupees(amountMinor: number): string {
  return `₹${(amountMinor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Whole minutes and seconds left, "m:ss"; "0:00" once past. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

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
  // The QR is live and the order is being polled.
  | 'awaiting'
  // The QR has expired, but a bank SMS for a payment made in time can still
  // arrive until the order's settleDeadline, so polling carries on.
  | 'late'
  | 'success'
  // Past the deadline with no payment seen.
  | 'unpaid'
  | 'error';

/**
 * Drives the order → UPI QR → confirm-by-polling flow for a chosen quantity of
 * credits, at the account's region rate, with an optional discount code.
 *
 * The buyer only scans and pays. 'success' is reached only when the API says
 * the order is paid, which happens only when a bank SMS forwarded from the
 * owner's phone (or an admin) settles it server-side. Nothing in this
 * component can mark an order paid.
 */
@Component({
  selector: 'app-buy-credits-button',
  imports: [ButtonModule, ProgressSpinnerModule, RouterLink],
  styleUrl: './buy-credits-button.css',
  templateUrl: './buy-credits-button.html',
})
export class BuyCreditsButton implements OnDestroy {
  private readonly billing = inject(BillingService);
  private readonly sanitizer = inject(DomSanitizer);

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

  /** The order being paid, as the API last described it. */
  protected readonly order = signal<UpiOrder | null>(null);

  /** The QR and payee, kept from creation or resume: the poll does not carry them. */
  protected readonly payment = signal<UpiPaymentInstructions | null>(null);

  /** Ticks every second while an order is open, for the countdown. */
  private readonly now = signal(Date.now());

  protected readonly amountLabel = computed(() => {
    const order = this.order();
    return order ? formatExactRupees(order.amountMinor) : '';
  });

  protected readonly countdown = computed(() => {
    const order = this.order();
    return order ? formatCountdown(Date.parse(order.expiresAt) - this.now()) : '';
  });

  protected readonly deadlineLabel = computed(() => {
    const order = this.order();
    if (!order) return '';
    return new Date(order.settleDeadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  /**
   * The upi:// link, trusted for an href. Angular's URL sanitizer only knows
   * web schemes and would prefix this one "unsafe:"; it is trusted only after
   * checking it is the payment-link shape the API builds.
   */
  protected readonly upiHref = computed<SafeUrl | null>(() => {
    const uri = this.payment()?.upiUri;
    return uri && uri.startsWith('upi://pay?') ? this.sanitizer.bypassSecurityTrustUrl(uri) : null;
  });

  /** True while an order is open. */
  readonly busy = computed(() => {
    const state = this.state();
    return state === 'ordering' || state === 'awaiting' || state === 'late';
  });

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

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
      // After the first render rather than in ngOnInit: the remembered order
      // lives in localStorage, which the server cannot see, so deciding it
      // during the first render would make hydration disagree with SSR.
      void this.resumePendingOrder();
    });
  }

  /**
   * Picks up an order that was open when the page went away. Resumed rather
   * than re-offered: the buyer may already have paid it.
   */
  private async resumePendingOrder(): Promise<void> {
    const orderId = this.billing.readPendingUpiOrder();
    if (orderId === null) return;

    const result = await this.billing.fetchUpiOrder(orderId, true);
    // The user may have started something else while this was in flight.
    if (this.state() !== 'idle') return;
    if (!result.ok) {
      if (result.reason === 'not_found') this.billing.forgetPendingUpiOrder();
      return;
    }
    this.payment.set(result.order.payment);
    this.apply(result.order);
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
    // A click in any other state is ignored outright rather than starting a
    // second order.
    if (this.state() !== 'idle') return;

    // The canonical quantity, never the raw field: what gets ordered is what
    // the label and the total have been showing, and what the backend accepts.
    const quantity = this.orderQuantity();
    if (quantity === null) return;
    this.commit(quantity);

    this.error.set(null);
    this.state.set('ordering');

    const code = this.promoCode().trim();
    const result = await this.billing.createUpiOrder(quantity, code.length > 0 ? code : undefined);
    if (!result.ok) {
      this.error.set(result.message);
      this.state.set('error');
      return;
    }

    this.payment.set(result.order.payment);
    // Remembered straight away: a reload can happen at any moment from here,
    // including after the buyer has paid.
    this.billing.rememberPendingUpiOrder(result.order);
    this.apply(result.order);
  }

  /** Moves the screen to whatever the order's status says. */
  private apply(order: UpiOrder): void {
    this.order.set(order);

    if (order.status === 'paid') {
      this.settleAsPurchased();
      return;
    }
    if (order.status === 'pending' && this.payment() !== null) {
      this.watch('awaiting');
      return;
    }
    if (Date.now() < Date.parse(order.settleDeadline)) {
      this.watch('late');
      return;
    }

    this.stopTimers();
    this.billing.forgetPendingUpiOrder();
    this.state.set('unpaid');
  }

  private watch(state: 'awaiting' | 'late'): void {
    this.state.set(state);
    this.now.set(Date.now());
    this.clockTimer ??= setInterval(() => this.now.set(Date.now()), 1000);
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null) return;
    const delay = this.state() === 'late' ? POLL_LATE_MS : POLL_LIVE_MS;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, delay);
  }

  private async pollOnce(): Promise<void> {
    const order = this.order();
    if (!order || !this.isWatching()) return;

    const result = await this.billing.fetchUpiOrder(order.orderId);

    // Re-checked after the await: the user may have gone back, or started a
    // new order, while this was in flight.
    if (!this.isWatching() || this.order()?.orderId !== order.orderId) return;

    if (result.ok) {
      this.apply(result.order);
    } else {
      // A failed check proves nothing about the payment; ask again.
      this.schedulePoll();
    }
  }

  private isWatching(): boolean {
    const state = this.state();
    return state === 'awaiting' || state === 'late';
  }

  private settleAsPurchased(): void {
    this.stopTimers();
    this.billing.forgetPendingUpiOrder();
    this.state.set('success');
    void this.billing.refreshCreditBalance();
    this.creditsAdded.emit();
  }

  /**
   * Back to the form. The order is not cancelled on the server: if the buyer
   * did pay it, the bank SMS still settles it and the credits still arrive.
   * This page just stops watching.
   */
  protected onStartOver(): void {
    this.stopTimers();
    this.billing.forgetPendingUpiOrder();
    this.order.set(null);
    this.payment.set(null);
    this.error.set(null);
    this.state.set('idle');
  }

  private stopTimers(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  ngOnDestroy(): void {
    // Timers would otherwise keep firing against a destroyed component. The
    // order itself is unaffected, and is picked back up on the next visit.
    this.stopTimers();
  }
}
