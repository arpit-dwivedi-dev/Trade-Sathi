import type { CreditPricing, FeatureCreditCost, PricingRegion } from "@chartanalyzer/shared";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { razorpay } from "../lib/razorpay-client.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";

/**
 * Credit purchasing and pricing. Replaces the old fixed-pack catalogue
 * (CREDIT_PACKS) entirely: a purchase is any quantity of credits at or above
 * the caller's region minimum, priced from credit_pricing_regions — pure
 * config, never a code change to reprice or add a region.
 *
 * Money is integer minor units (paise / cents), never a float.
 */

interface CreditPricingRegionRow {
  region: PricingRegion;
  currency: string;
  price_per_credit_minor: number;
  min_purchase_credits: number;
  max_purchase_credits: number;
  purchase_increment_credits: number;
  quick_amounts_minor: number[];
}

async function readActivePricingRegion(
  region: PricingRegion,
): Promise<CreditPricingRegionRow | null> {
  const { data, error } = await supabaseAdmin
    .from("credit_pricing_regions")
    .select(
      "region, currency, price_per_credit_minor, min_purchase_credits, max_purchase_credits, purchase_increment_credits, quick_amounts_minor",
    )
    .eq("region", region)
    .eq("is_active", true)
    .maybeSingle<CreditPricingRegionRow>();
  if (error) {
    throw error;
  }
  return data;
}

function toCreditPricing(row: CreditPricingRegionRow): CreditPricing {
  return {
    region: row.region,
    currency: row.currency,
    pricePerCreditMinor: row.price_per_credit_minor,
    minPurchaseCredits: row.min_purchase_credits,
    maxPurchaseCredits: row.max_purchase_credits,
    purchaseIncrementCredits: row.purchase_increment_credits,
    quickAmountsMinor: row.quick_amounts_minor,
  };
}

/**
 * The caller's region and its current credit rate/purchase rules, for
 * GET /api/pricing.
 *
 * Throws if the region has no active row — both regions this app sells in
 * are seeded and active, so reaching that is a configuration problem, not an
 * expected outcome a caller branches on.
 */
export async function getCreditPricing(region: PricingRegion): Promise<CreditPricing> {
  const row = await readActivePricingRegion(region);
  if (!row) {
    throw new Error(`No active credit_pricing_regions row for region ${region}`);
  }
  return toCreditPricing(row);
}

interface FeatureCreditCostRow {
  feature_key: string;
  credits: number;
}

/** Every active feature's cost in credits, for GET /api/pricing. */
export async function getFeatureCreditCosts(): Promise<FeatureCreditCost[]> {
  const { data, error } = await supabaseAdmin
    .from("feature_credit_costs")
    .select("feature_key, credits")
    .eq("is_active", true);
  if (error) {
    throw error;
  }
  return (data ?? []).map((row: FeatureCreditCostRow) => ({
    featureKey: row.feature_key,
    credits: row.credits,
  }));
}

/**
 * Why begin_credit_purchase refused an order. Every arm but the last is a rule
 * the SQL function enforces; provider_error is ours, and means Razorpay could
 * not be reached.
 */
export type CreateCreditOrderRejection =
  | "region_unavailable"
  | "below_minimum_purchase"
  | "above_maximum_purchase"
  | "invalid_quantity_step"
  | "invalid_promo_code"
  | "provider_error";

/**
 * What begin_credit_purchase returns. The pricing rules and the promo caps
 * both live in SQL now — see the migration (20260917160000) for why they
 * cannot be enforced correctly from here.
 *
 * Each rejection carries the limit it refused on, so the message below can
 * name the real number instead of restating a constant that lives somewhere
 * else and can drift out of step with the row it came from.
 */
type BeginCreditPurchaseRejection =
  | { ok: false; reason: "region_unavailable" }
  | { ok: false; reason: "below_minimum_purchase"; minCredits: number }
  | { ok: false; reason: "above_maximum_purchase"; maxCredits: number }
  | { ok: false; reason: "invalid_quantity_step"; stepCredits: number }
  | { ok: false; reason: "invalid_promo_code" };

type BeginCreditPurchaseOutcome =
  | {
      ok: true;
      paymentId: string;
      amountMinor: number;
      discountMinor: number;
      currency: string;
      creditsRequested: number;
    }
  | BeginCreditPurchaseRejection;

function rejectionMessage(rejection: BeginCreditPurchaseRejection): string {
  switch (rejection.reason) {
    case "below_minimum_purchase":
      return `A purchase must be at least ${rejection.minCredits} credits`;
    case "above_maximum_purchase":
      return `A purchase can be at most ${rejection.maxCredits} credits`;
    case "invalid_quantity_step":
      return `Credits are sold in steps of ${rejection.stepCredits}`;
    case "invalid_promo_code":
      // Every reason the SQL checks collapses to this one word: no such code,
      // expired, inactive, wrong region, caps hit. Telling a caller which
      // guessed codes used to be real — or exist but do something else — is a
      // free enumeration oracle.
      return "That promo code is not valid";
    case "region_unavailable":
      return "Credit purchases are not available in your region";
  }
}

export type CreateCreditOrderResult =
  | {
      ok: true;
      orderId: string;
      keyId: string;
      amountMinor: number;
      currency: string;
      creditsRequested: number;
    }
  | {
      ok: false;
      reason: CreateCreditOrderRejection;
      message: string;
    };

/**
 * Creates a Razorpay Order for a chosen quantity of credits and records it
 * locally, returning the identifiers Razorpay Checkout needs on the client.
 *
 * Pricing, purchase bounds and promo validation all happen inside
 * begin_credit_purchase, in one transaction, and that transaction writes the
 * 'created' payments row before it returns. This function's remaining job is
 * the part that cannot be in SQL: the call to Razorpay, and linking the order
 * id it hands back to the row that already exists.
 *
 * The ordering is deliberate and is the reverse of what it used to be. The
 * row is written first, without an order id, because the row is what claims a
 * promo slot — see the claim-window comment in the migration. If the Razorpay
 * call then fails, the claim is released; a row that is left behind with a
 * null provider_order_id is invisible to the webhook and to
 * reconcileCreditOrder, both of which look orders up by that column, so an
 * abandoned claim can never be paid against.
 *
 * Expected outcomes are returned as a discriminated result; only genuinely
 * unexpected failures (DB errors) throw, and the route maps those to 500.
 */
export async function createCreditOrder(
  profileId: string,
  region: PricingRegion,
  quantity: number,
  promoCode?: string | null,
): Promise<CreateCreditOrderResult> {
  const trimmedPromoCode = promoCode?.trim();

  const claimed = await callRpc<BeginCreditPurchaseOutcome>("begin_credit_purchase", {
    p_profile_id: profileId,
    p_region: region,
    p_quantity: quantity,
    p_promo_code: trimmedPromoCode ? trimmedPromoCode : null,
  });

  if (!claimed.ok) {
    return { ok: false, reason: claimed.reason, message: rejectionMessage(claimed) };
  }

  const { paymentId, amountMinor, currency } = claimed;

  // Past this point a promo slot is held and a payments row exists, so every
  // exit that does not end in a usable order has to give both back. Scoped to
  // a row that still has no order id, so this can only ever clear a claim that
  // was never linked — never one a concurrent request has already filled in.
  const abandonClaim = async (): Promise<void> => {
    try {
      const { error } = await supabaseAdmin
        .from("payments")
        .delete()
        .eq("id", paymentId)
        .is("provider_order_id", null);
      if (error) {
        throw error;
      }
    } catch (cause) {
      // The row survives and keeps holding its promo slot until it ages out
      // of the claim window. Worth a line in the log; not worth failing the
      // caller's request over, and not worth masking whatever brought us here.
      logger.warn("could not release an abandoned credit purchase claim", {
        profileId,
        paymentId,
        cause: String(cause),
      });
    }
  };

  // notes carry the profile id so a purchase can be traced back from the
  // Razorpay dashboard, but they are NOT the mechanism the webhook uses to
  // attribute the payment — that goes through the payments row written above,
  // which is our own record and cannot be influenced by the client.
  let order;
  try {
    order = await razorpay.orders.create({
      amount: amountMinor,
      currency,
      notes: { profile_id: profileId, credits: String(quantity) },
    });
  } catch {
    // The caught error is deliberately not inspected, forwarded, or logged
    // here: Razorpay error payloads can echo request details and key
    // material, and nothing from them may reach a response body. The route
    // logs a generic failure instead.
    await abandonClaim();
    return {
      ok: false,
      reason: "provider_error",
      message: "The payment provider could not create the order",
    };
  }

  const { error: linkError } = await supabaseAdmin
    .from("payments")
    .update({ provider_order_id: order.id })
    .eq("id", paymentId)
    .is("provider_order_id", null);
  if (linkError) {
    // Our own write failed, not the provider's, so this is a 500 rather than
    // provider_error — the route's message about the provider being
    // unavailable would be untrue. The Razorpay order that just got created
    // is simply never shown to the buyer and expires unpaid on its own.
    await abandonClaim();
    throw linkError;
  }

  // RAZORPAY_KEY_ID is the publishable key and is safe to return — it is
  // what Razorpay Checkout's JS widget needs on the frontend. The secret key
  // must never appear in any response body, log line, or error message.
  return {
    ok: true,
    orderId: order.id,
    keyId: env.razorpayKeyId,
    amountMinor,
    currency,
    creditsRequested: quantity,
  };
}

export type ReconcileCreditOrderResult =
  | { ok: true; outcome: "applied" | "duplicate" }
  | { ok: false; reason: "not_found" | "not_paid" | "provider_error" };

/**
 * Establishes whether an Order this profile created has actually been paid, by
 * asking Razorpay directly, and grants if it has.
 *
 * This is the second, independent way a purchase can be confirmed. The webhook
 * is the first, and remains the fast path — but it is a push from a third party
 * with no delivery guarantee and, on a local dev server, no route to us at all.
 * Without this, a missed delivery means a customer has paid and the only
 * automated recovery is none: the client polls a row that will never change.
 *
 * Both paths converge on apply_credit_purchase, so the balance movement and
 * the idempotency guard live in one place — including the promo-code
 * finalization, which that function reads off the payments row itself and
 * this function does not need to know about. If the webhook lands while this
 * is in flight, the FOR UPDATE inside apply_credit_purchase serializes them
 * and the loser returns 'duplicate'.
 *
 * 'captured' is the only provider status acted on, matching exactly what the
 * webhook path acts on (payment.captured). An 'authorized' payment is money
 * reserved but not yet taken — granting on it would hand over credits for a
 * payment that can still fail or be voided.
 *
 * Expected outcomes are returned as a discriminated result; only a DB read
 * failure throws, and the route maps that to 500.
 */
export async function reconcileCreditOrder(
  profileId: string,
  providerOrderId: string,
): Promise<ReconcileCreditOrderResult> {
  // Scoped to the caller's own profile, not looked up by order id alone: this
  // endpoint moves credits, and the order id travels through the browser.
  //
  // amount_minor and currency are read here to be checked against what
  // Razorpay reports below, so they have to come from this row and not from
  // the request.
  const { data: payment, error: lookupError } = await supabaseAdmin
    .from("payments")
    .select("id, status, amount_minor, currency")
    .eq("provider_order_id", providerOrderId)
    .eq("profile_id", profileId)
    .maybeSingle<{
      id: string;
      status: string;
      amount_minor: number;
      currency: string;
    }>();

  if (lookupError) {
    throw new Error(lookupError.message);
  }

  if (!payment) {
    return { ok: false, reason: "not_found" };
  }

  // Already settled — by the webhook, or by an earlier call to this function.
  // Answered without a provider round-trip, so the client's retries are cheap.
  if (payment.status === "captured") {
    return { ok: true, outcome: "duplicate" };
  }

  // Not inspected or forwarded, for the same reason as in createCreditOrder:
  // Razorpay error payloads can echo request details and key material.
  const orderPayments = await razorpay.orders
    .fetchPayments(providerOrderId)
    .catch(() => null);

  if (orderPayments === null) {
    return { ok: false, reason: "provider_error" };
  }

  const captured = orderPayments.items.find((item) => item.status === "captured");
  if (!captured) {
    // The user has not completed Checkout yet, or the payment failed. Not an
    // error — the honest answer is that there is nothing to confirm yet.
    return { ok: false, reason: "not_paid" };
  }

  // What Razorpay says it took has to match what this order was for, or the
  // credits are not granted. The order id is a lookup key, not a proof of
  // amount: Razorpay can capture less than the order's full value, and the
  // payments row is the only thing here that knows what this order was
  // actually sold as. Without this check a short capture would be honoured as
  // a full one and the difference would be credits given away.
  //
  // Number() rather than a bare ===, because the SDK's own type for this
  // field is `amount: number | string` (types/payments.d.ts) — a strict
  // comparison would silently refuse every capture that arrived as a string.
  // It stays exact about the value: the coercion does not loosen the match, it
  // only stops the encoding from deciding it. It also fails closed, since
  // Number(undefined) is NaN and NaN matches nothing, so a payload that
  // dropped the field refuses the grant rather than waving it through.
  //
  // Reported as not_paid rather than as its own reason, deliberately: a
  // mismatch is not something a retry fixes, and not_paid is the arm that
  // leaves the client waiting rather than telling the buyer something untrue
  // about the provider. The error log is the real signal — this should never
  // happen, so it wants a human looking at the two numbers.
  if (
    Number(captured.amount) !== payment.amount_minor ||
    captured.currency !== payment.currency
  ) {
    logger.error("captured amount does not match the order; refusing to grant credits", {
      profileId,
      providerOrderId,
      providerPaymentId: captured.id,
      expectedAmountMinor: payment.amount_minor,
      capturedAmountMinor: captured.amount,
      expectedCurrency: payment.currency,
      capturedCurrency: captured.currency,
    });
    return { ok: false, reason: "not_paid" };
  }

  const outcome = await callRpc<string>("apply_credit_purchase", {
    p_provider_order_id: providerOrderId,
    p_provider_payment_id: captured.id,
    // False, and it is not a shortcoming: this capture was established by
    // querying Razorpay's API, not by checking a signature over a webhook
    // body. The column records which of the two happened.
    p_signature_verified: false,
  });

  if (outcome === "order_not_found") {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true, outcome: outcome === "duplicate" ? "duplicate" : "applied" };
}
