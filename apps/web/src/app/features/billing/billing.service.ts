import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  EntryPassPrice,
  PricingOverview,
  PricingRegion,
  PromoRedeemOutcome,
  PublicTopUpPackPrice,
} from '@chartanalyzer/shared';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';

const CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

const POLL_INTERVAL_MS = 2000;
/**
 * Generous on purpose. Webhook processing completed within seconds in backend
 * testing, but that testing fabricated the deliveries — this is the first time
 * a real Razorpay-originated webhook exercises the chain, so give it room.
 */
const POLL_TIMEOUT_MS = 60_000;
/** Consecutive query failures (~6s of continuous failure) before giving up. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** Minimal surface of Razorpay Checkout that this feature actually uses. */
interface RazorpayCheckoutBase {
  key: string;
  name: string;
  description: string;
  prefill?: { email: string };
  handler: () => void;
  modal: { ondismiss: () => void };
}

/**
 * The two Checkout modes are mutually exclusive, and the union enforces that.
 * A subscription is opened with `subscription_id` and no amount (the plan
 * fixes it); a one-time Order is opened with `order_id`, `amount` and
 * `currency`. Passing both, or mixing fields across modes, is a Checkout
 * error — so they are kept as separate variants rather than one shape with
 * everything optional.
 */
type RazorpayCheckoutOptions =
  | (RazorpayCheckoutBase & { subscription_id: string })
  | (RazorpayCheckoutBase & { order_id: string; amount: number; currency: string });

interface RazorpayCheckoutInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;
  }
}

export type SubscribeResult =
  | { ok: true; subscriptionId: string; keyId: string }
  | { ok: false; reason: 'already_subscribed' | 'invalid_plan' | 'error'; message: string };

export type CheckoutOutcome = { outcome: 'submitted' } | { outcome: 'dismissed' };

export type SubscriptionPollOutcome = 'active' | 'timed_out' | 'poll_error';

export interface SubscriptionPollHandle {
  result: Promise<SubscriptionPollOutcome>;
  cancel: () => void;
}

/**
 * Which credit currency a top-up buys. 'analysis' tops up manual analyses;
 * 'daily_briefing' tops up automated watchlist runs. Deliberately not
 * interchangeable — see CREDIT_PACKS in apps/api/src/services/credits.service.ts.
 *
 * 'entry_pass' is not a currency but a one-time, once-per-account starter
 * purchase of 5 analysis credits. It rides the same order → Checkout → poll
 * machinery, so it lives in this union and CREDIT_ENDPOINTS rather than in a
 * parallel copy of the whole flow.
 */
export type CreditPackKind = 'analysis' | 'daily_briefing' | 'entry_pass';

/**
 * One endpoint per currency, not one endpoint taking the currency: a client
 * that could name the pack could pay the cheaper price and be granted the
 * dearer credits.
 */
const CREDIT_ENDPOINTS: Record<CreditPackKind, string> = {
  analysis: '/api/billing/buy-credits',
  daily_briefing: '/api/billing/buy-briefing-credits',
  entry_pass: '/api/billing/buy-entry-pass',
};

/**
 * The payments.purpose an entry-pass purchase is recorded under, mirrored from
 * CREDIT_PACKS.entry_pass.purpose in apps/api/src/services/credits.service.ts —
 * the same copy-not-share trade as LIVE_SUBSCRIPTION_STATUSES below. It is how
 * the once-per-account gate is recognised in payment history, so it is read
 * here to answer "has this account already used its pass?" before offering it.
 */
const ENTRY_PASS_PURPOSE = 'entry_pass_5';

export type BuyCreditsResult =
  | { ok: true; orderId: string; keyId: string; amountMinor: number; currency: string }
  | { ok: false; reason: 'error' | 'already_purchased'; message: string };

export type CreditPollOutcome = 'captured' | 'timed_out' | 'poll_error';

/**
 * The answer to "is this order paid?", as far as the backend could establish.
 *
 * 'unknown' is deliberately not folded into 'pending': pending means the
 * provider was reached and says not yet, unknown means nobody found out. Both
 * leave the purchase unconfirmed, but only one is a statement about the
 * payment, and the caller may want to word them differently later.
 */
export type ReconcileOutcome = 'captured' | 'pending' | 'unknown';

export interface CreditPollHandle {
  result: Promise<CreditPollOutcome>;
  cancel: () => void;
}

/**
 * Where the in-flight purchase is remembered across a page reload.
 *
 * Written when Checkout reports the user submitted, cleared the moment the
 * purchase is resolved one way or another. It exists because the confirming
 * state is otherwise purely in memory: a refresh during confirmation dropped
 * the user back to an enabled Buy button with no sign their payment was ever in
 * flight, and no way back to watching for it.
 *
 * It carries the pack kind as well as the order id, and every read is scoped to
 * one kind. All three pack buttons render on the billing page at once, so a
 * single shared entry would have every one of them resume the same order and
 * claim to be confirming it.
 *
 * It is a hint about this browser, not a record: the payments row is the
 * record, and nothing about entitlement is ever read from here.
 */
const PENDING_ORDER_STORAGE_KEY = 'chartanalyzer.pending-credit-order';

/**
 * How long a remembered order stays resumable.
 *
 * An abandoned Checkout leaves a 'created' payments row behind by design (it is
 * inert until a webhook captures it), so the row alone cannot distinguish "in
 * flight" from "given up on". Recency is the cheapest honest discriminator: an
 * order this age has been paid or it never will be, and Razorpay's own Checkout
 * session is long gone by then.
 */
const PENDING_ORDER_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * The manual-analysis tiers, of which a user holds exactly one at a time — the
 * tier that occupies profiles.plan_id and sets the monthly analysis allowance.
 *
 * Anything NOT in this set is an add-on: a separate SKU, billed through the
 * same subscriptions table, that a user holds *alongside* their manual tier
 * rather than instead of it (see the comment at the top of
 * supabase/migrations/20260831160400_daily_briefing_entitlement_functions.sql
 * — a Daily Briefing entitlement is a live subscriptions row, never
 * profiles.plan_id). Treating the two families as one list is what made the
 * account screen claim a user was on one plan while silently holding another.
 *
 * Exported because the picker splits its cards on exactly this distinction and
 * must not carry a second copy of the list that can drift from this one.
 */
export const MANUAL_PLAN_KEYS: ReadonlySet<string> = new Set([
  'free',
  'starter_monthly',
  'pro_monthly',
  'pro_annual',
]);

/**
 * Subscription statuses that mean "this subscription is in force". Mirrors
 * LIVE_SUBSCRIPTION_STATUSES in apps/api/src/services/billing.service.ts and
 * the status list in check_and_consume_daily_briefing_entitlement — all three
 * must agree, or the UI shows an add-on the backend won't honour (or hides one
 * it will). 'created' is excluded here for the same reason it is there: it only
 * means a checkout was opened, not that anything was paid for.
 */
const LIVE_SUBSCRIPTION_STATUSES = [
  'authenticated',
  'active',
  'pending',
  'halted',
  'paused',
] as const;

/**
 * The one Daily Briefing plan key. Hardcoded for the same reason the backend's
 * PURCHASABLE_PLAN_KEYS and daily_briefing_entitlements' own lookups are: there
 * is exactly one briefing SKU, and its allowance is keyed by this literal in
 * check_and_consume_daily_briefing_entitlement.
 */
const DAILY_BRIEFING_PLAN_KEY = 'daily_briefing_monthly';

/**
 * A period's consumption of one allowance. `used`/`limit` are the same numbers
 * the SQL entitlement function compares, so the screen and the enforcement
 * cannot disagree.
 */
export interface UsageStatus {
  used: number;
  limit: number;
  remaining: number;
}

/** One add-on the user currently holds, for display on the account screen. */
export interface AddOnSummary {
  /** plans.key — 'daily_briefing_monthly' today. */
  key: string;
  name: string;
  amountMinor: number;
  /** From the subscriptions row — the currency actually being charged. */
  currency: string;
  currentPeriodEnd: string | null;
}

/**
 * What the account screen shows about the current plan. `currentPeriodEnd` is
 * null for free-plan users, who have no subscriptions row at all — that is the
 * normal case, not an error.
 */
export interface PlanSummary {
  /** plans.key — 'free', 'starter_monthly', 'pro_monthly'. */
  key: string;
  name: string;
  /**
   * The plan's price in the account's locked region, with its currency —
   * the same plan_prices row the backend charges from. The base
   * plans.price_inr_paise stays in the query only as the fallback when no
   * region row matches, which would itself be catalogue drift.
   */
  priceMinor: number;
  currency: string;
  analysesPerMonth: number;
  /**
   * The locked pricing region this account is billed in ('IN' | 'GLOBAL').
   * Read from the profile alongside the plan, because both the plan picker's
   * price query and the pack buttons' labels must use the same region the
   * backend will charge in. Null when it could not be read — callers fall
   * back to 'IN', the region with active prices, matching the backend's
   * detection fallback.
   */
  pricingRegion: PricingRegion | null;
  /**
   * The renewal date of the MANUAL tier's own subscription, and only that one.
   * Reading "the newest subscription row" instead put an add-on's renewal date
   * under the manual plan's price the moment a user held both — the exact
   * conflation this whole split exists to stop.
   */
  currentPeriodEnd: string | null;
  /** Live add-ons held alongside this tier. Empty for most users. */
  addOns: AddOnSummary[];
  /**
   * Unspent Daily Briefing top-up credits. Separate from the manual credit
   * balance and from the add-on's monthly allowance: these are what a user
   * buys to run MORE briefings inside a month, since the add-on subscription
   * itself cannot be bought twice for extra quota.
   */
  briefingCreditBalance: number;
  /**
   * Unspent manual analysis top-up credits (profiles.credit_balance). Spent
   * only after the monthly allowance is gone, which is why the account screen
   * shows it beside the quota meter rather than folded into it: a user sitting
   * at 100/100 still has these to draw on, and hiding them read as "you are
   * out" when they were not.
   */
  creditBalance: number;
  /**
   * This period's Daily Briefing consumption against the add-on's allowance,
   * or null when no live briefing subscription is held — a user with only
   * top-up credits has no monthly allowance to meter, and rendering "0 / 0"
   * would claim an exhausted quota that does not exist.
   */
  briefingUsage: UsageStatus | null;
  /**
   * Whether the once-per-account entry pass has been bought and captured. Its
   * button reads this so the offer is not made a second time: the backend
   * would answer the attempt with a 409 after the user had already sat through
   * a checkout window.
   */
  entryPassUsed: boolean;
}

/** A live subscriptions row joined to its plan, as fetchPlanSummary reads it. */
interface LiveSubscriptionRow {
  current_period_end: string | null;
  amount_minor: number;
  currency: string;
  plans: { key: string; name: string } | null;
}

/**
 * Formats an integer minor-unit amount with its currency's symbol and
 * grouping: 39900/INR → "₹399", 500/USD → "$5". One formatter because every
 * money surface (plan cards, pack buttons, billing receipt, public pricing)
 * must print the same number the same way.
 *
 * Zero is NOT a price. A zero amount is the free plan, which grants no
 * allowance (the paywall retired it) and therefore has nothing to charge, so
 * it renders as an em dash rather than as free-of-charge.
 */
export function formatPriceMinor(amountMinor: number, currency: string): string {
  if (amountMinor === 0) return '—';
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${symbol}${(amountMinor / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}`;
}

/** The set of PromoRedeemOutcome values other than 'applied' — every rejected
 * redemption reason the backend can send. */
const REJECTED_PROMO_OUTCOMES: ReadonlySet<string> = new Set([
  'duplicate',
  'invalid_code',
  'expired',
  'exhausted',
]);

/** Narrows an unknown error-body field to a rejected PromoRedeemOutcome,
 * without trusting the server to have sent one of the values the type
 * promises. */
function isRejectedPromoOutcome(
  value: unknown,
): value is Exclude<PromoRedeemOutcome, 'applied'> {
  return typeof value === 'string' && REJECTED_PROMO_OUTCOMES.has(value);
}

@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);

  /**
   * localStorage does not exist during SSR, the same guard ThemeService uses.
   * Only the remembered-pending-order helpers need it — they are about this
   * particular browser, not about the account.
   */
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Cached so concurrent callers share one script injection. */
  private checkoutScript: Promise<void> | null = null;

  /**
   * The current plan, shared by every consumer that needs to know which tier
   * the user is on — the nav's Upgrade/Buy Credits label, the plans overlay,
   * and the plan picker's "Current plan" marker.
   *
   * Held here rather than fetched per component so those three read one
   * query's result instead of issuing the same query three times. It is the
   * cache in front of fetchPlanSummary(), not a second way to read the plan.
   */
  private readonly planSummary = signal<PlanSummary | null>(null);

  /** GET /api/pricing, cached — see ensurePricing(). */
  private readonly pricing = signal<PricingOverview | null>(null);

  /** Dedupes concurrent first-loads onto one in-flight request. */
  private pricingRequest: Promise<PricingOverview | null> | null = null;

  /** null until the first load resolves, and for users whose plan can't be read. */
  readonly currentPlanKey = computed(() => this.planSummary()?.key ?? null);
  readonly currentPlan = this.planSummary.asReadonly();

  /**
   * The account's locked pricing region, or null while unknown (not loaded /
   * read failure). Consumers displaying region-priced amounts must treat null
   * as 'IN' — the backend's own fallback, and the only region with active
   * prices today — never as "hide the price".
   */
  readonly pricingRegion = computed<PricingRegion | null>(
    () => this.planSummary()?.pricingRegion ?? null,
  );

  /**
   * The paid one-off packs, priced by the backend's own catalogue — the same
   * rows the order endpoints charge from, so an advertised amount and a
   * charged amount are one number. Empty while unknown, and empty for a region
   * that sells none: a pack we cannot price is a pack we must not offer, since
   * createCreditOrder answers it with 'pack_unavailable'.
   */
  readonly topUpPacks = computed<readonly PublicTopUpPackPrice[]>(
    () => this.pricing()?.topUpPacks ?? [],
  );

  /** The entry pass's price and grant for this account's region. */
  readonly entryPassPrice = computed<EntryPassPrice | null>(
    () => this.pricing()?.entryPass ?? null,
  );

  /**
   * Whether the one-off top-up packs can be sold to this account. Gates the
   * sections offering them.
   *
   * Read from the price catalogue rather than by comparing pricingRegion() to
   * 'GLOBAL': the catalogue is what decides what is sellable, and comparing
   * region names treated an *unknown* region — not loaded yet, or a failed
   * summary read — as India, offering a GLOBAL account two packs the backend
   * refuses. False while unknown, so the packs appear only once they are known
   * to be purchasable.
   */
  readonly hasTopUpPacks = computed(() => this.topUpPacks().length > 0);

  /**
   * Whether the once-per-account entry pass has been spent. False while the
   * summary hasn't loaded — the button is left on screen rather than hidden on
   * a failed read, because the order endpoint still holds the real gate and
   * its 409 is handled as 'used_up'.
   */
  readonly entryPassUsed = computed(() => this.planSummary()?.entryPassUsed ?? false);

  /**
   * Keys of the add-ons the user already holds. The picker reads this to mark
   * those cards as current instead of offering them: an add-on is not covered
   * by currentPlanKey (which only ever names the manual tier), so before this
   * existed a held add-on was still rendered with a live "Choose" button, and
   * clicking it could only ever come back as the backend's 409.
   */
  readonly heldAddOnKeys = computed<ReadonlySet<string>>(
    () => new Set((this.planSummary()?.addOns ?? []).map((addOn) => addOn.key)),
  );

  /**
   * Whether this profile can currently run a Daily Briefing at all — a live
   * `daily_briefing_monthly` add-on, or a leftover top-up credit even without
   * one. Mirrors exactly what check_and_consume_daily_briefing_entitlement
   * checks server-side (LIVE add-on OR briefingCreditBalance > 0), so a
   * consumer gating UI on this signal doesn't disagree with what the backend
   * will actually accept.
   *
   * Null while the plan summary hasn't loaded yet — callers should treat that
   * as "unknown", not "no entitlement", to avoid a flash of gated UI before
   * the real answer arrives.
   */
  readonly hasDailyBriefingEntitlement = computed<boolean | null>(() => {
    const summary = this.planSummary();
    if (!summary) return null;
    return summary.addOns.some((addOn) => addOn.key === DAILY_BRIEFING_PLAN_KEY) ||
      summary.briefingCreditBalance > 0;
  });

  /** Dedupes concurrent first-loads onto one in-flight request. */
  private planSummaryRequest: Promise<PlanSummary | null> | null = null;

  /**
   * Loads the plan summary once and caches it. Repeat callers get the cached
   * value; concurrent callers share the one in-flight request.
   */
  async ensurePlanSummary(): Promise<PlanSummary | null> {
    const cached = this.planSummary();
    if (cached) return cached;
    this.planSummaryRequest ??= this.fetchPlanSummary().then((summary) => {
      this.planSummary.set(summary);
      // Cleared either way: a failed read must not be cached as "no plan"
      // forever, so the next caller retries.
      this.planSummaryRequest = null;
      return summary;
    });
    return this.planSummaryRequest;
  }

  /**
   * Re-reads the plan, bypassing the cache. Called after a successful upgrade,
   * when the cached tier is exactly what has just gone stale.
   *
   * Concurrent callers share the one request. Two surfaces do refresh on the
   * same event — a redeemed promo fires both the redeem box's own refresh and
   * its host's — and without this they issued two identical reads and raced to
   * write the same signal.
   */
  async refreshPlanSummary(): Promise<PlanSummary | null> {
    this.planSummaryRequest ??= this.fetchPlanSummary().then((summary) => {
      this.planSummary.set(summary);
      this.planSummaryRequest = null;
      return summary;
    });
    return this.planSummaryRequest;
  }

  /**
   * Loads the region's price list once and caches it. Same discipline as
   * ensurePlanSummary: repeat callers take the cache, concurrent callers share
   * the one request, and a failed read is not cached — so the next caller
   * retries instead of pinning the app to "no prices".
   *
   * The endpoint is public, but the token is sent anyway: an authenticated
   * caller gets the region locked on their profile, which is the region the
   * backend will charge in.
   */
  async ensurePricing(): Promise<PricingOverview | null> {
    const cached = this.pricing();
    if (cached) return cached;
    this.pricingRequest ??= this.fetchPricing().finally(() => {
      this.pricingRequest = null;
    });
    return this.pricingRequest;
  }

  private async fetchPricing(): Promise<PricingOverview | null> {
    try {
      const token = await this.auth.getAccessToken();
      const overview = await firstValueFrom(
        this.http.get<PricingOverview>('/api/pricing', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
      );
      this.pricing.set(overview);
      return overview;
    } catch (cause) {
      console.warn('pricing lookup failed', cause);
      return null;
    }
  }

  /**
   * Asks the backend to create a Razorpay Subscription for this profile on the
   * given plan. `planKey` is a plans.key value; the backend re-validates it
   * against its own whitelist and 400s on anything else.
   */
  async subscribe(planKey: string): Promise<SubscribeResult> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      return { ok: false, reason: 'error', message: 'You are not signed in.' };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ subscriptionId: string; keyId: string }>(
          '/api/billing/subscribe',
          { planKey },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return { ok: true, subscriptionId: response.subscriptionId, keyId: response.keyId };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;

      if (status === 409) {
        return {
          ok: false,
          reason: 'already_subscribed',
          message: 'You already have a subscription in progress.',
        };
      }
      if (status === 400) {
        // The picker only offers keys the backend accepts, so this means the UI
        // and the backend whitelist have drifted apart. Nothing the user can
        // fix — but surfaced rather than folded into the generic message, so it
        // is recognisable as a bug when it shows up.
        console.warn('backend rejected the plan key', cause);
        return {
          ok: false,
          reason: 'invalid_plan',
          message: "That plan isn't available. Please pick another one.",
        };
      }
      // 500 (our own misconfiguration) and 502 (the provider failed) are both
      // nothing the user can act on differently, so they share one reason.
      return {
        ok: false,
        reason: 'error',
        message: "Couldn't start the upgrade. Please try again.",
      };
    }
  }

  /**
   * Asks the backend to create a Razorpay Order for one credit pack.
   *
   * Unlike subscribe() there is no 409-equivalent for the top-up packs — they
   * are repeatable one-time purchases. The entry pass is the exception: it is
   * once per account, so the backend answers 409 'already_purchased' and the
   * button renders that as a used-up state rather than an error.
   */
  async buyCredits(kind: CreditPackKind): Promise<BuyCreditsResult> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      return { ok: false, reason: 'error', message: 'You are not signed in.' };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ orderId: string; keyId: string; amountMinor: number; currency: string }>(
          CREDIT_ENDPOINTS[kind],
          {},
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return {
        ok: true,
        orderId: response.orderId,
        keyId: response.keyId,
        amountMinor: response.amountMinor,
        currency: response.currency,
      };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;

      if (status === 409) {
        return {
          ok: false,
          reason: 'already_purchased',
          message: 'This account has already used its entry pass.',
        };
      }
      // 500 (our own misconfiguration) and 502 (the provider failed) are both
      // nothing the user can act on differently, so they share one reason.
      console.warn('credit order request failed', cause);
      return {
        ok: false,
        reason: 'error',
        message: "Couldn't start the purchase. Please try again.",
      };
    }
  }

  /**
   * Asks the backend to ask Razorpay whether this Order has been paid, and to
   * grant its credits if so.
   *
   * This is the fallback for the case the polling loop cannot cover: the webhook
   * never arrived. It exists because that is not an edge case — a Razorpay
   * webhook is a push from outside with no delivery guarantee, and against a
   * local dev server there is no route to us at all, so the purchase could
   * otherwise never be confirmed no matter how long the user waited.
   *
   * Returns 'unknown' rather than throwing for every failure, because the caller
   * has nothing different to do about any of them: the purchase stays
   * unconfirmed, and the user is told so plainly.
   */
  async reconcileCreditOrder(orderId: string): Promise<ReconcileOutcome> {
    const token = await this.auth.getAccessToken();
    if (!token) return 'unknown';

    try {
      const response = await firstValueFrom(
        this.http.post<{ status: 'captured' | 'pending' }>(
          '/api/billing/verify-order',
          { orderId },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return response.status === 'captured' ? 'captured' : 'pending';
    } catch (cause) {
      // 404 (not our order), 502 (provider down) and 500 (our bug) are all the
      // same thing to the user: still unconfirmed. Logged so a real fault is
      // distinguishable from an unpaid order when someone goes looking.
      console.warn('order reconciliation failed', cause);
      return 'unknown';
    }
  }

  /**
   * Remembers the order the user is currently waiting on, so a reload can
   * resume watching it. See PENDING_ORDER_STORAGE_KEY.
   */
  rememberPendingCreditOrder(orderId: string, kind: CreditPackKind): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(
        PENDING_ORDER_STORAGE_KEY,
        JSON.stringify({ orderId, kind, at: Date.now() }),
      );
    } catch {
      // Private-mode or blocked storage. The purchase still confirms — this
      // only costs the resume-on-reload behaviour.
    }
  }

  /**
   * Drops the remembered order for one pack — it is no longer in flight.
   *
   * Scoped by kind like the read, so a pack settling cannot clear the record of
   * a different pack's purchase while that one is still being confirmed.
   */
  forgetPendingCreditOrder(kind: CreditPackKind): void {
    if (!this.isBrowser) return;
    try {
      if (this.readPendingOrder()?.kind === kind) {
        localStorage.removeItem(PENDING_ORDER_STORAGE_KEY);
      }
    } catch {
      // Nothing to do: a stale entry is discarded by age on the next read.
    }
  }

  /**
   * The order id to resume watching for one pack, or null if there is nothing
   * worth resuming. Scoped by kind because every pack button reads this, and
   * only the one that started the purchase has anything to resume.
   *
   * An expired entry is cleared as it is read, so a stale one cannot keep
   * re-arming itself.
   */
  readPendingCreditOrder(kind: CreditPackKind): string | null {
    const pending = this.readPendingOrder();
    if (pending === null) return null;

    if (Date.now() - pending.at >= PENDING_ORDER_MAX_AGE_MS) {
      this.forgetPendingCreditOrder(kind);
      return null;
    }

    return pending.kind === kind ? pending.orderId : null;
  }

  /**
   * The stored entry, whatever pack it belongs to, or null when there is none
   * or it cannot be read. Every failure is treated as "nothing remembered": the
   * cost is a Buy button that reappears, which is where this started.
   */
  private readPendingOrder(): { orderId: string; kind: string; at: number } | null {
    if (!this.isBrowser) return null;

    try {
      const raw = localStorage.getItem(PENDING_ORDER_STORAGE_KEY);
      if (!raw) return null;

      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return null;
      const { orderId, kind, at } = parsed as {
        orderId?: unknown;
        kind?: unknown;
        at?: unknown;
      };
      if (typeof orderId !== 'string' || typeof kind !== 'string' || typeof at !== 'number') {
        return null;
      }
      return { orderId, kind, at };
    } catch {
      // Unparseable, or storage unavailable (private mode, blocked site data).
      return null;
    }
  }

  /**
   * Redeems a promo code. Returns the raw outcome rather than a message: the
   * words differ per outcome and per surface, and the balance refresh — not
   * this call — is what shows the granted credits.
   */
  async redeemPromoCode(code: string): Promise<
    { ok: true; outcome: 'applied' } | { ok: false; outcome: Exclude<PromoRedeemOutcome, 'applied'> }
  > {
    const token = await this.auth.getAccessToken();
    if (!token) {
      // The redeem input only renders for signed-in users; reaching here means
      // the session dropped between render and click.
      return { ok: false, outcome: 'invalid_code' };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ outcome: PromoRedeemOutcome }>(
          '/api/billing/redeem-promo',
          { code },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return response.outcome === 'applied'
        ? { ok: true, outcome: 'applied' }
        : { ok: false, outcome: response.outcome };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;
      // The non-'applied' outcomes arrive as their mapped error statuses
      // (409 duplicate/exhausted, 404 invalid, 410 expired) carrying the
      // outcome in the body; read it back out rather than flattening every
      // failure to a generic one. The body is `unknown` — HttpErrorResponse
      // types `.error` as `any`, so it's narrowed by hand rather than cast.
      const body: unknown = cause instanceof HttpErrorResponse ? cause.error : undefined;
      const bodyOutcome =
        body !== null && typeof body === 'object' && 'outcome' in body ? body.outcome : undefined;
      if (isRejectedPromoOutcome(bodyOutcome)) {
        return { ok: false, outcome: bodyOutcome };
      }
      console.warn('promo redeem request failed', { status, cause });
      return { ok: false, outcome: 'invalid_code' };
    }
  }

  /**
   * Injects Razorpay's Checkout script, resolving once it has loaded.
   *
   * Browser-only, and guarded the same way compressImage is: `document` and
   * `window` do not exist during SSR, so fail loudly rather than reaching for
   * an undefined global.
   */
  loadCheckoutScript(): Promise<void> {
    if (!this.supabase.isBrowser) {
      return Promise.reject(
        new Error('loadCheckoutScript is browser-only and cannot run during SSR'),
      );
    }

    if (window.Razorpay) return Promise.resolve();
    if (this.checkoutScript) return this.checkoutScript;

    this.checkoutScript = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CHECKOUT_SCRIPT_SRC;
      script.async = true;
      script.addEventListener('load', () => resolve());
      script.addEventListener('error', () => {
        // Drop the cached promise so a later attempt can retry: the usual cause
        // is an ad blocker or a flaky network, both of which can change.
        this.checkoutScript = null;
        reject(new Error('Failed to load Razorpay Checkout'));
      });
      document.body.appendChild(script);
    });

    return this.checkoutScript;
  }

  /**
   * Opens Razorpay Checkout for an already-created subscription.
   *
   * IMPORTANT: the `handler` callback fires when the user completes the
   * Checkout form — it is NOT proof that the subscription is active. Razorpay's
   * own subscription documentation states that verification for subscriptions
   * happens via webhooks, not the client-side callback. So this resolves
   * 'submitted' and sets no "subscribed" state of any kind; confirming actual
   * entitlement is pollSubscriptionStatus's job.
   */
  openCheckout(
    subscriptionId: string,
    keyId: string,
    prefillEmail: string | null,
  ): Promise<CheckoutOutcome> {
    if (!this.supabase.isBrowser) {
      return Promise.reject(new Error('openCheckout is browser-only and cannot run during SSR'));
    }

    const Razorpay = window.Razorpay;
    if (!Razorpay) {
      return Promise.reject(new Error('Razorpay Checkout is not loaded'));
    }

    return new Promise<CheckoutOutcome>((resolve) => {
      const checkout = new Razorpay({
        key: keyId,
        subscription_id: subscriptionId,
        name: 'ChartAnalyzer',
        description: 'Pro Monthly',
        prefill: prefillEmail ? { email: prefillEmail } : undefined,
        handler: () => resolve({ outcome: 'submitted' }),
        modal: { ondismiss: () => resolve({ outcome: 'dismissed' }) },
      });
      checkout.open();
    });
  }

  /**
   * Opens Razorpay Checkout for an already-created credit-pack Order.
   *
   * IMPORTANT: exactly as in openCheckout, the `handler` callback fires when
   * the user completes the Checkout form — it is NOT proof that the payment
   * was captured or that any credits exist. Credits are granted only by
   * apply_credit_purchase, driven by the signature-verified webhook. So this
   * resolves 'submitted' and grants nothing; confirming the purchase is
   * pollCreditPurchase's job.
   *
   * The script is the same one the subscribe flow loads, so loadCheckoutScript
   * is reused as-is and is already cached after the first load.
   *
   * amount and currency are passed through from the order response rather
   * than assumed here: the server owns the price — and the region picks the
   * currency (₹49 IN vs $5 GLOBAL entry pass), so a hardcoded 'INR' would
   * make Checkout reject the order Razorpay just created. The description is
   * the caller's label for the same reason.
   */
  openCreditCheckout(
    orderId: string,
    keyId: string,
    amountMinor: number,
    currency: string,
    description: string,
    prefillEmail: string | null,
  ): Promise<CheckoutOutcome> {
    if (!this.supabase.isBrowser) {
      return Promise.reject(
        new Error('openCreditCheckout is browser-only and cannot run during SSR'),
      );
    }

    const Razorpay = window.Razorpay;
    if (!Razorpay) {
      return Promise.reject(new Error('Razorpay Checkout is not loaded'));
    }

    return new Promise<CheckoutOutcome>((resolve) => {
      const checkout = new Razorpay({
        key: keyId,
        order_id: orderId,
        // Passed through from the backend rather than hardcoded here: the
        // server owns the price, and a client-side constant could drift from
        // it silently. Razorpay validates it against the Order regardless.
        amount: amountMinor,
        currency,
        name: 'ChartAnalyzer',
        description,
        prefill: prefillEmail ? { email: prefillEmail } : undefined,
        handler: () => resolve({ outcome: 'submitted' }),
        modal: { ondismiss: () => resolve({ outcome: 'dismissed' }) },
      });
      checkout.open();
    });
  }

  /**
   * Polls the payments row until the webhook flips it to 'captured'.
   *
   * Reads through the browser Supabase client — the existing
   * `profile_id = auth.uid()` select policy on payments already permits this,
   * so no backend endpoint is needed. Same shape and cancellation contract as
   * pollSubscriptionStatus.
   */
  pollCreditPurchase(orderId: string): CreditPollHandle {
    const client = this.supabase.client;

    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();

    const result = new Promise<CreditPollOutcome>((resolve) => {
      const stop = (): void => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };

      // Every exit path clears the interval first: an interval still firing
      // after resolution is a bug.
      const finish = (outcome: CreditPollOutcome): void => {
        if (settled) return;
        settled = true;
        stop();
        resolve(outcome);
      };

      if (!client) {
        // SSR has no Supabase client; nothing can be polled.
        finish('poll_error');
        return;
      }

      const tick = async (): Promise<void> => {
        if (settled) return;

        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
          // Not a failure: the payment has most likely succeeded and the
          // webhook is simply still in flight. We just stop waiting here.
          finish('timed_out');
          return;
        }

        try {
          const { data, error } = await client
            .from('payments')
            .select('status')
            .eq('provider_order_id', orderId)
            .single<{ status: string }>();

          if (error || !data) throw error ?? new Error('Payment row not found');

          consecutiveFailures = 0;
          if (settled) return;

          if (data.status === 'captured') finish('captured');
        } catch (cause) {
          // A read error here is a *frontend* problem (network, client config),
          // not the payment failing. One blip just waits for the next scheduled
          // poll, which doubles as the retry; only sustained failure gives up.
          consecutiveFailures += 1;
          console.warn('credit purchase poll attempt failed', cause);

          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            finish('poll_error');
          }
        }
      };

      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
      void tick();
    });

    return {
      result,
      cancel: () => {
        // Called from ngOnDestroy: the caller has already stopped caring, so the
        // promise is simply left unresolved rather than given a special outcome.
        settled = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  }

  /**
   * Polls the subscriptions row until the webhook flips it to 'active'.
   *
   * Reads through the browser Supabase client — the existing
   * `profile_id = auth.uid()` select policy already permits this, so no backend
   * endpoint is needed. Same shape and cancellation contract as
   * AnalyzeService.pollAnalysis: a bare Promise cannot be cancelled from
   * outside, and the component must stop polling on destroy.
   */
  pollSubscriptionStatus(providerSubscriptionId: string): SubscriptionPollHandle {
    const client = this.supabase.client;

    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();

    const result = new Promise<SubscriptionPollOutcome>((resolve) => {
      const stop = (): void => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };

      // Every exit path clears the interval first: an interval still firing
      // after resolution is a bug.
      const finish = (outcome: SubscriptionPollOutcome): void => {
        if (settled) return;
        settled = true;
        stop();
        resolve(outcome);
      };

      if (!client) {
        // SSR has no Supabase client; nothing can be polled.
        finish('poll_error');
        return;
      }

      const tick = async (): Promise<void> => {
        if (settled) return;

        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
          // Not a failure: the payment has most likely succeeded and the
          // webhook is simply still in flight. We just stop waiting here.
          finish('timed_out');
          return;
        }

        try {
          const { data, error } = await client
            .from('subscriptions')
            .select('status')
            .eq('provider_subscription_id', providerSubscriptionId)
            .single<{ status: string }>();

          if (error || !data) throw error ?? new Error('Subscription row not found');

          consecutiveFailures = 0;
          if (settled) return;

          if (data.status === 'active') finish('active');
        } catch (cause) {
          // A read error here is a *frontend* problem (network, client config),
          // not the payment failing. One blip just waits for the next scheduled
          // poll, which doubles as the retry; only sustained failure gives up.
          consecutiveFailures += 1;
          console.warn('subscription poll attempt failed', cause);

          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            finish('poll_error');
          }
        }
      };

      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
      void tick();
    });

    return {
      result,
      cancel: () => {
        // Called from ngOnDestroy: the caller has already stopped caring, so the
        // promise is simply left unresolved rather than given a special outcome.
        settled = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  }

  /**
   * The user's plan and, if they have one, their subscription's period end.
   *
   * Read straight from Supabase like fetchQuota(): plans has a public SELECT
   * policy for active rows and subscriptions is RLS-scoped to profile_id =
   * auth.uid(), so no backend endpoint is needed.
   *
   * Returns null when it can't be determined (SSR, no session, read error) —
   * the caller renders nothing rather than guessing a plan.
   */
  async fetchPlanSummary(): Promise<PlanSummary | null> {
    const client = this.supabase.client;
    if (!client) return null;

    const profileId = this.auth.user()?.id;
    if (!profileId) return null;

    // The same UTC bucket check_and_consume_daily_briefing_entitlement derives
    // with to_char(now() at time zone 'UTC', 'YYYY-MM'). Local time would read
    // the wrong month's counter near a boundary.
    const period = new Date().toISOString().slice(0, 7);

    try {
      const [profile, subscriptions, briefingCounter, briefingEntitlement, entryPass] =
        await Promise.all([
          client
            .from('profiles')
            .select(
              'credit_balance, daily_briefing_credit_balance, pricing_region, ' +
                'plans(key, name, price_inr_paise, analyses_per_month, ' +
                'plan_prices(amount_minor, currency, region))',
            )
            .eq('id', profileId)
            .single<{
              credit_balance: number;
              daily_briefing_credit_balance: number;
              pricing_region: PricingRegion | null;
              plans: {
                key: string;
                name: string;
                price_inr_paise: number;
                analyses_per_month: number;
                plan_prices: { amount_minor: number; currency: string; region: PricingRegion }[];
              } | null;
            }>(),
          client
            .from('subscriptions')
            .select('current_period_end, amount_minor, currency, plans!inner(key, name)')
            // Every live subscription, not just the newest one: a user can hold a
            // manual tier and an add-on at the same time, and both are needed
            // here. Newest first so that when a plan has accumulated rows over
            // time (a resubscribe writes a new one) the current period wins.
            .eq('profile_id', profileId)
            .in('status', [...LIVE_SUBSCRIPTION_STATUSES])
            .order('created_at', { ascending: false })
            .returns<LiveSubscriptionRow[]>(),
          // Both briefing reads are issued unconditionally rather than after the
          // subscription check: whether the add-on is held is only known once
          // that query resolves, and sequencing on it would cost a second
          // round-trip to save two cheap reads (one own-row counter, one
          // publicly-readable entitlement row). The result is discarded below if
          // no live subscription turns up.
          client
            .from('daily_briefing_usage_counters')
            .select('analyses_used')
            .eq('profile_id', profileId)
            .eq('period', period)
            .maybeSingle<{ analyses_used: number }>(),
          client
            .from('daily_briefing_entitlements')
            .select('monthly_auto_analyses')
            .eq('plan_key', DAILY_BRIEFING_PLAN_KEY)
            .maybeSingle<{ monthly_auto_analyses: number }>(),
          // Whether the once-per-account entry pass is spent. Mirrors
          // createCreditOrder's own gate exactly — same purpose, same 'captured'
          // status — because the point is to not offer the purchase the order
          // endpoint is about to refuse. payments is readable for own rows, so
          // this needs no backend endpoint.
          client
            .from('payments')
            .select('id', { count: 'exact', head: true })
            .eq('purpose', ENTRY_PASS_PURPOSE)
            .eq('status', 'captured'),
        ]);

      if (profile.error) throw profile.error;
      if (subscriptions.error) throw subscriptions.error;
      if (briefingCounter.error) throw briefingCounter.error;
      if (briefingEntitlement.error) throw briefingEntitlement.error;
      if (entryPass.error) throw entryPass.error;

      const plan = profile.data?.plans;
      if (!plan) return null;

      // Both regions' rows arrive (PostgREST can't filter a nested select on a
      // sibling column of the same outer row); the account's locked region —
      // 'IN' as fallback, matching the backend's detection fallback — picks
      // which one is the real price.
      const region: PricingRegion = profile.data?.pricing_region ?? 'IN';
      const regionPrice = plan.plan_prices?.find((row) => row.region === region);
      // Falling back to the plan's IN list price keeps the screen readable if
      // the region row is missing, but that is catalogue drift worth noticing.
      const priceMinor = regionPrice?.amount_minor ?? plan.price_inr_paise;
      const currency = regionPrice?.currency ?? 'INR';

      const live = subscriptions.data ?? [];

      // Scoped to the manual tier's own key. A user on Pro with a Daily
      // Briefing add-on has two live rows, and the add-on's is often the newer
      // of the two — so "the newest row" would date the manual plan's renewal
      // off the add-on's billing cycle.
      const manual = live.find((row) => row.plans?.key === plan.key);

      // Deduped by key: an add-on that has been resubscribed has more than one
      // live row, and it is one product either way. Newest-first ordering means
      // the first row seen for a key is the current one.
      const addOns = new Map<string, AddOnSummary>();
      for (const row of live) {
        const rowPlan = row.plans;
        if (!rowPlan || MANUAL_PLAN_KEYS.has(rowPlan.key) || addOns.has(rowPlan.key)) continue;
        addOns.set(rowPlan.key, {
          key: rowPlan.key,
          name: rowPlan.name,
          amountMinor: row.amount_minor,
          currency: row.currency,
          currentPeriodEnd: row.current_period_end,
        });
      }

      // Metered only while the subscription that grants the allowance is live.
      // A lapsed subscriber keeps any credits they bought (the SQL function
      // serves them deliberately) but has no monthly allowance left to show.
      const briefingLimit = addOns.has(DAILY_BRIEFING_PLAN_KEY)
        ? (briefingEntitlement.data?.monthly_auto_analyses ?? null)
        : null;
      // No counter row yet just means nothing has run this month.
      const briefingUsed = briefingCounter.data?.analyses_used ?? 0;

      return {
        key: plan.key,
        name: plan.name,
        priceMinor,
        currency,
        analysesPerMonth: plan.analyses_per_month,
        pricingRegion: profile.data?.pricing_region ?? null,
        currentPeriodEnd: manual?.current_period_end ?? null,
        addOns: [...addOns.values()],
        briefingCreditBalance: profile.data?.daily_briefing_credit_balance ?? 0,
        creditBalance: profile.data?.credit_balance ?? 0,
        briefingUsage:
          briefingLimit === null
            ? null
            : {
                used: briefingUsed,
                limit: briefingLimit,
                remaining: Math.max(0, briefingLimit - briefingUsed),
              },
        entryPassUsed: (entryPass.count ?? 0) > 0,
      };
    } catch (cause) {
      console.warn('plan summary lookup failed', cause);
      return null;
    }
  }
}
