import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  CreditTransaction,
  PricingOverview,
  PricingRegion,
  PromoRedeemOutcome,
} from '@tradesathi/shared';

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
interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { email: string };
  handler: () => void;
  modal: { ondismiss: () => void };
}

interface RazorpayCheckoutInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;
  }
}

export type CheckoutOutcome = { outcome: 'submitted' } | { outcome: 'dismissed' };

export type BuyCreditsResult =
  | {
      ok: true;
      orderId: string;
      keyId: string;
      amountMinor: number;
      currency: string;
      creditsRequested: number;
    }
  | { ok: false; reason: 'below_minimum_purchase' | 'invalid_promo_code' | 'error'; message: string };

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
 * One purchase mechanism now (a chosen quantity of credits, not a pack), so —
 * unlike the old plan-era version of this key — there is nothing to scope the
 * entry by beyond the order id itself.
 */
const PENDING_ORDER_STORAGE_KEY = 'tradesathi.pending-credit-order';

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
 * Formats an integer minor-unit amount with its currency's symbol and
 * grouping: 39900/INR → "₹399", 500/USD → "$5". One formatter because every
 * money surface (buy-credits control, billing page, public pricing) must
 * print the same number the same way.
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
  'not_eligible_region',
]);

/** Narrows an unknown error-body field to a rejected PromoRedeemOutcome,
 * without trusting the server to have sent one of the values the type
 * promises. */
function isRejectedPromoOutcome(
  value: unknown,
): value is Exclude<PromoRedeemOutcome, 'applied'> {
  return typeof value === 'string' && REJECTED_PROMO_OUTCOMES.has(value);
}

/** A credit_ledger row as Postgres/PostgREST returns it — snake_case columns. */
interface CreditLedgerRow {
  id: string;
  delta: number;
  reason: CreditTransaction['reason'];
  feature_key: string | null;
  balance_after: number;
  created_at: string;
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
   * The one balance every paid feature spends from, shared by every consumer
   * that needs it — the nav rail, the analyze/fundamentals/daily-briefing
   * screens, the billing page — so those read one query's result instead of
   * issuing the same query repeatedly. It is the cache in front of
   * fetchCreditBalance(), not a second way to read the balance.
   */
  private readonly creditBalanceState = signal<number | null>(null);
  readonly creditBalance = this.creditBalanceState.asReadonly();

  /** Dedupes concurrent first-loads/refreshes onto one in-flight request. */
  private creditBalanceRequest: Promise<number | null> | null = null;

  /** GET /api/pricing, cached — see ensurePricing(). */
  private readonly pricingState = signal<PricingOverview | null>(null);
  readonly pricing = this.pricingState.asReadonly();

  /** Dedupes concurrent first-loads onto one in-flight request. */
  private pricingRequest: Promise<PricingOverview | null> | null = null;

  /**
   * The account's price band, or null while unknown (not loaded / read
   * failure). Sourced from the pricing overview rather than a plan summary —
   * there are no plans any more, and this is the one place the backend states
   * which band it will charge in.
   */
  readonly pricingRegion = computed<PricingRegion | null>(
    () => this.pricingState()?.pricing.region ?? null,
  );

  /**
   * Loads the credit balance once and caches it. Repeat callers get the cached
   * value; concurrent callers share the one in-flight request.
   */
  async ensureCreditBalance(): Promise<number | null> {
    const cached = this.creditBalanceState();
    if (cached !== null) return cached;
    this.creditBalanceRequest ??= this.fetchCreditBalance().then((balance) => {
      this.creditBalanceState.set(balance);
      // Cleared either way: a failed read must not be cached as "no balance"
      // forever, so the next caller retries.
      this.creditBalanceRequest = null;
      return balance;
    });
    return this.creditBalanceRequest;
  }

  /**
   * Re-reads the balance, bypassing the cache. Called after a purchase, a
   * redeemed promo code, or a feature run — anything that just spent or
   * granted credits, where the cached figure is exactly what has gone stale.
   *
   * Concurrent callers share the one request, so two surfaces refreshing on
   * the same event don't race to write the same signal from two reads.
   */
  async refreshCreditBalance(): Promise<number | null> {
    this.creditBalanceRequest ??= this.fetchCreditBalance().then((balance) => {
      this.creditBalanceState.set(balance);
      this.creditBalanceRequest = null;
      return balance;
    });
    return this.creditBalanceRequest;
  }

  /**
   * Reads profiles.credit_balance straight from Supabase — the select-own RLS
   * policy already permits this, so no backend endpoint is needed.
   *
   * Returns null when it can't be determined (SSR, no session, read error) —
   * callers must not treat "unknown" as "zero".
   */
  async fetchCreditBalance(): Promise<number | null> {
    const client = this.supabase.client;
    if (!client) return null;

    const profileId = this.auth.user()?.id;
    if (!profileId) return null;

    try {
      const { data, error } = await client
        .from('profiles')
        .select('credit_balance')
        .eq('id', profileId)
        .single<{ credit_balance: number }>();
      if (error) throw error;
      return data?.credit_balance ?? 0;
    } catch (cause) {
      console.warn('credit balance lookup failed', cause);
      return null;
    }
  }

  /**
   * The billing page's recent-activity list: the last `limit` credit_ledger
   * rows for this profile, newest first. Read straight from Supabase — same
   * select-own RLS pattern as fetchCreditBalance — mapped from the table's
   * snake_case columns to the shared CreditTransaction shape.
   *
   * Returns an empty list on any failure (SSR, no session, read error) rather
   * than null: the page renders "no activity yet", which is also the honest
   * state for a brand-new account.
   */
  async fetchCreditHistory(limit = 20): Promise<CreditTransaction[]> {
    const client = this.supabase.client;
    if (!client) return [];

    const profileId = this.auth.user()?.id;
    if (!profileId) return [];

    try {
      const { data, error } = await client
        .from('credit_ledger')
        .select('id, delta, reason, feature_key, balance_after, created_at')
        .order('created_at', { ascending: false })
        .limit(limit)
        .returns<CreditLedgerRow[]>();
      if (error) throw error;

      return (data ?? []).map((row) => ({
        id: row.id,
        delta: row.delta,
        reason: row.reason,
        featureKey: row.feature_key,
        balanceAfter: row.balance_after,
        createdAt: row.created_at,
      }));
    } catch (cause) {
      console.warn('credit history lookup failed', cause);
      return [];
    }
  }

  /**
   * Loads the region's price list once and caches it. Same discipline as
   * ensureCreditBalance: repeat callers take the cache, concurrent callers
   * share the one request, and a failed read is not cached — so the next
   * caller retries instead of pinning the app to "no prices".
   *
   * The endpoint is public, but the token is sent anyway: an authenticated
   * caller gets the region locked on their profile, which is the region the
   * backend will charge in.
   */
  async ensurePricing(): Promise<PricingOverview | null> {
    const cached = this.pricingState();
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
      this.pricingState.set(overview);
      return overview;
    } catch (cause) {
      console.warn('pricing lookup failed', cause);
      return null;
    }
  }

  /**
   * Asks the backend to create a Razorpay Order for `quantity` credits at this
   * account's region rate, with an optional promo code applied as a discount.
   *
   * Replaces the old fixed-pack buyCredits(kind): there is one purchase flow
   * now, for any quantity at or above the region's minimum, so there is
   * nothing left to parameterise by SKU.
   */
  async purchaseCredits(quantity: number, promoCode?: string): Promise<BuyCreditsResult> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      return { ok: false, reason: 'error', message: 'You are not signed in.' };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{
          orderId: string;
          keyId: string;
          amountMinor: number;
          currency: string;
          creditsRequested: number;
        }>(
          '/api/billing/purchase-credits',
          promoCode ? { quantity, promoCode } : { quantity },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return {
        ok: true,
        orderId: response.orderId,
        keyId: response.keyId,
        amountMinor: response.amountMinor,
        currency: response.currency,
        creditsRequested: response.creditsRequested,
      };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;

      if (status === 400) {
        // The route answers both a below-minimum quantity and an invalid
        // promo code with the same status; `reason` in the body is what
        // actually distinguishes them (see billing.route.ts's
        // purchase-credits handler).
        const body: unknown = cause instanceof HttpErrorResponse ? cause.error : undefined;
        const message =
          body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : "That purchase couldn't be started.";
        const bodyReason =
          body !== null && typeof body === 'object' && 'reason' in body ? body.reason : undefined;
        const reason =
          bodyReason === 'invalid_promo_code' ? 'invalid_promo_code' : 'below_minimum_purchase';
        return { ok: false, reason, message };
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
  rememberPendingCreditOrder(orderId: string): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(PENDING_ORDER_STORAGE_KEY, JSON.stringify({ orderId, at: Date.now() }));
    } catch {
      // Private-mode or blocked storage. The purchase still confirms — this
      // only costs the resume-on-reload behaviour.
    }
  }

  /** Drops the remembered order — it is no longer in flight. */
  forgetPendingCreditOrder(): void {
    if (!this.isBrowser) return;
    try {
      localStorage.removeItem(PENDING_ORDER_STORAGE_KEY);
    } catch {
      // Nothing to do: a stale entry is discarded by age on the next read.
    }
  }

  /**
   * The order id to resume watching, or null if there is nothing worth
   * resuming.
   *
   * An expired entry is cleared as it is read, so a stale one cannot keep
   * re-arming itself. Every failure (unparseable, storage unavailable) is
   * treated as "nothing remembered": the cost is a Buy button that reappears,
   * which is where this started.
   */
  readPendingCreditOrder(): string | null {
    if (!this.isBrowser) return null;

    try {
      const raw = localStorage.getItem(PENDING_ORDER_STORAGE_KEY);
      if (!raw) return null;

      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return null;
      const { orderId, at } = parsed as { orderId?: unknown; at?: unknown };
      if (typeof orderId !== 'string' || typeof at !== 'number') return null;

      if (Date.now() - at >= PENDING_ORDER_MAX_AGE_MS) {
        this.forgetPendingCreditOrder();
        return null;
      }

      return orderId;
    } catch {
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
          '/api/billing/redeem',
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
      // (409 duplicate/exhausted, 404 invalid, 410 expired, 400
      // not_eligible_region) carrying the outcome in the body; read it back
      // out rather than flattening every failure to a generic one. The body
      // is `unknown` — HttpErrorResponse types `.error` as `any`, so it's
      // narrowed by hand rather than cast.
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
   * Opens Razorpay Checkout for an already-created credit Order.
   *
   * IMPORTANT: the `handler` callback fires when the user completes the
   * Checkout form — it is NOT proof that the payment was captured or that any
   * credits exist. Credits are granted only by apply_credit_purchase, driven
   * by the signature-verified webhook. So this resolves 'submitted' and grants
   * nothing; confirming the purchase is pollCreditPurchase's job.
   *
   * amount and currency are passed through from the order response rather
   * than assumed here: the server owns the price — and the region picks the
   * currency (₹ IN vs $ GLOBAL) — so a hardcoded 'INR' would make Checkout
   * reject the order Razorpay just created. The description is the caller's
   * label for the same reason.
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
        name: 'TradeSathi',
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
   * so no backend endpoint is needed.
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
}
