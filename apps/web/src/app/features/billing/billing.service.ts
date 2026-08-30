import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
  | { ok: false; reason: 'already_subscribed' | 'error'; message: string };

export type CheckoutOutcome = { outcome: 'submitted' } | { outcome: 'dismissed' };

export type SubscriptionPollOutcome = 'active' | 'timed_out' | 'poll_error';

export interface SubscriptionPollHandle {
  result: Promise<SubscriptionPollOutcome>;
  cancel: () => void;
}

export type BuyCreditsResult =
  | { ok: true; orderId: string; keyId: string; amountMinor: number }
  | { ok: false; reason: 'error'; message: string };

export type CreditPollOutcome = 'captured' | 'timed_out' | 'poll_error';

export interface CreditPollHandle {
  result: Promise<CreditPollOutcome>;
  cancel: () => void;
}

/**
 * What the account screen shows about the current plan. `currentPeriodEnd` is
 * null for free-plan users, who have no subscriptions row at all — that is the
 * normal case, not an error.
 */
export interface PlanSummary {
  name: string;
  priceInrPaise: number;
  analysesPerMonth: number;
  currentPeriodEnd: string | null;
}

@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);

  /** Cached so concurrent callers share one script injection. */
  private checkoutScript: Promise<void> | null = null;

  /** Asks the backend to create a Razorpay Subscription for this profile. */
  async subscribe(): Promise<SubscribeResult> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      return { ok: false, reason: 'error', message: 'You are not signed in.' };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ subscriptionId: string; keyId: string }>(
          '/api/billing/subscribe',
          {},
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
   * Unlike subscribe() there is no 409-equivalent: credit packs are one-time
   * purchases with no "already has one" state, so every non-201 collapses to a
   * single 'error' reason.
   */
  async buyCredits(): Promise<BuyCreditsResult> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      return { ok: false, reason: 'error', message: 'You are not signed in.' };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ orderId: string; keyId: string; amountMinor: number }>(
          '/api/billing/buy-credits',
          {},
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return {
        ok: true,
        orderId: response.orderId,
        keyId: response.keyId,
        amountMinor: response.amountMinor,
      };
    } catch (cause) {
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
   */
  openCreditCheckout(
    orderId: string,
    keyId: string,
    amountMinor: number,
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
        currency: 'INR',
        name: 'ChartAnalyzer',
        description: '10 analysis credits',
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

    try {
      const [profile, subscription] = await Promise.all([
        client
          .from('profiles')
          .select('plans(name, price_inr_paise, analyses_per_month)')
          .eq('id', profileId)
          .single<{
            plans: { name: string; price_inr_paise: number; analyses_per_month: number } | null;
          }>(),
        client
          .from('subscriptions')
          .select('current_period_end')
          // A profile can accumulate rows over time (a resubscribe writes a new
          // one); the newest is the one whose period is current.
          .eq('profile_id', profileId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle<{ current_period_end: string | null }>(),
      ]);

      if (profile.error) throw profile.error;
      if (subscription.error) throw subscription.error;

      const plan = profile.data?.plans;
      if (!plan) return null;

      return {
        name: plan.name,
        priceInrPaise: plan.price_inr_paise,
        analysesPerMonth: plan.analyses_per_month,
        currentPeriodEnd: subscription.data?.current_period_end ?? null,
      };
    } catch (cause) {
      console.warn('plan summary lookup failed', cause);
      return null;
    }
  }
}
