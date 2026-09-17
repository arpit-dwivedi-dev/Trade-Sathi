import type { CreditPricing, FeatureCreditCost, PricingRegion } from "@chartanalyzer/shared";
import { env } from "../lib/env.js";
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
 * A promo_codes row's discount-relevant columns. free_credits and the
 * redeem-only columns are irrelevant here — that path is
 * redeem_promo_code_credits, called from promo.service.ts — so they are not
 * selected.
 *
 * discount_percent is numeric(5,2) in Postgres, which the client returns as
 * a string; every read of it below goes through Number(...).
 */
interface PromoCodeDiscountRow {
  id: string;
  discount_percent: string | null;
  discount_fixed_minor: number | null;
  max_discount_amount_minor: number | null;
  min_purchase_amount_minor: number | null;
  max_redemptions: number | null;
  redemption_count: number;
  per_user_limit: number;
  region_eligibility: PricingRegion[] | null;
  starts_at: string | null;
  expires_at: string | null;
  is_active: boolean;
}

/** Escapes ILIKE's own wildcard characters so a code lookup is an exact,
 *  case-insensitive match rather than a pattern search. */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

type DiscountOutcome =
  | { ok: true; discountMinor: number; promoCodeId: string }
  | { ok: false };

/**
 * Validates a discount code against one order's region and pre-discount
 * amount, and computes the discount it earns.
 *
 * Every rejection reason collapses to the same `{ ok: false }` — mirroring
 * redeem_promo_code_credits's 'invalid_code', which deliberately does not
 * distinguish "no such code" from "exists but expired" from "exists but is a
 * free-credits-only code": telling a caller which guessed codes used to be
 * real, or do something else, is a free enumeration oracle. A code with no
 * discount component (free_credits only) is treated exactly like an unknown
 * code for this purpose.
 */
async function resolveDiscount(
  profileId: string,
  code: string,
  region: PricingRegion,
  baseAmountMinor: number,
): Promise<DiscountOutcome> {
  const { data: promo, error } = await supabaseAdmin
    .from("promo_codes")
    .select(
      "id, discount_percent, discount_fixed_minor, max_discount_amount_minor, min_purchase_amount_minor, max_redemptions, redemption_count, per_user_limit, region_eligibility, starts_at, expires_at, is_active",
    )
    .ilike("code", escapeLikePattern(code))
    .maybeSingle<PromoCodeDiscountRow>();
  if (error) {
    throw error;
  }

  const invalid: DiscountOutcome = { ok: false };

  if (!promo || !promo.is_active) return invalid;
  if (promo.discount_percent === null && promo.discount_fixed_minor === null) return invalid;
  if (promo.starts_at && new Date(promo.starts_at).getTime() > Date.now()) return invalid;
  if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) return invalid;
  if (
    promo.region_eligibility &&
    promo.region_eligibility.length > 0 &&
    !promo.region_eligibility.includes(region)
  ) {
    return invalid;
  }
  if (promo.min_purchase_amount_minor !== null && baseAmountMinor < promo.min_purchase_amount_minor) {
    return invalid;
  }
  if (promo.max_redemptions !== null && promo.redemption_count >= promo.max_redemptions) {
    return invalid;
  }

  const { count, error: countError } = await supabaseAdmin
    .from("promo_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("code_id", promo.id)
    .eq("profile_id", profileId)
    .eq("redemption_type", "discount");
  if (countError) {
    throw countError;
  }
  if ((count ?? 0) >= promo.per_user_limit) return invalid;

  let discountMinor: number;
  if (promo.discount_percent !== null) {
    discountMinor = Math.round((baseAmountMinor * Number(promo.discount_percent)) / 100);
    if (promo.max_discount_amount_minor !== null) {
      discountMinor = Math.min(discountMinor, promo.max_discount_amount_minor);
    }
  } else {
    discountMinor = Math.min(promo.discount_fixed_minor ?? 0, baseAmountMinor);
  }

  return { ok: true, discountMinor, promoCodeId: promo.id };
}

/**
 * Razorpay's documented minimum order amount, per currency. A discount is
 * clamped rather than allowed to push an order below this floor — see the
 * clamping comment in createCreditOrder.
 */
const MIN_ORDER_AMOUNT_MINOR: Record<PricingRegion, number> = {
  IN: 100, // ₹1.00
  GLOBAL: 50, // $0.50
};

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
      reason:
        | "below_minimum_purchase"
        | "above_maximum_purchase"
        | "invalid_quantity_step"
        | "invalid_promo_code"
        | "region_unavailable"
        | "provider_error";
      message: string;
    };

/**
 * Creates a Razorpay Order for a chosen quantity of credits and records it
 * locally, returning the identifiers Razorpay Checkout needs on the client.
 *
 * An optional promo code, if it validates as a discount code for this region
 * and order size, reduces the charged amount; apply_credit_purchase finalizes
 * that code's bookkeeping (redemption_count, the promo_redemptions row) at
 * capture time, off the promo_code_id recorded on the payments row below —
 * this function does not re-validate the code at that point.
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
  const pricingRow = await readActivePricingRegion(region);
  if (!pricingRow) {
    return {
      ok: false,
      reason: "region_unavailable",
      message: "Credit purchases are not available in your region",
    };
  }

  // The purchase bounds are enforced here and only here. The buy form clamps
  // and snaps too, but that is a convenience for the honest user: nothing
  // stops a caller posting to this endpoint directly, so a quantity outside
  // [min, max] or off the increment has to be refused server-side or it is
  // not refused at all.
  if (!Number.isInteger(quantity) || quantity < pricingRow.min_purchase_credits) {
    return {
      ok: false,
      reason: "below_minimum_purchase",
      message: `A purchase must be at least ${pricingRow.min_purchase_credits} credits`,
    };
  }

  if (quantity > pricingRow.max_purchase_credits) {
    return {
      ok: false,
      reason: "above_maximum_purchase",
      message: `A purchase can be at most ${pricingRow.max_purchase_credits} credits`,
    };
  }

  // Counted from the minimum, not from zero, so a region whose minimum is
  // itself off the increment's grid still accepts its own minimum.
  if ((quantity - pricingRow.min_purchase_credits) % pricingRow.purchase_increment_credits !== 0) {
    return {
      ok: false,
      reason: "invalid_quantity_step",
      message: `Credits are sold in steps of ${pricingRow.purchase_increment_credits}`,
    };
  }

  const baseAmountMinor = quantity * pricingRow.price_per_credit_minor;

  let discountMinor = 0;
  let promoCodeId: string | null = null;

  const trimmedPromoCode = promoCode?.trim();
  if (trimmedPromoCode) {
    const discount = await resolveDiscount(profileId, trimmedPromoCode, region, baseAmountMinor);
    if (!discount.ok) {
      return {
        ok: false,
        reason: "invalid_promo_code",
        message: "That promo code is not valid",
      };
    }
    discountMinor = discount.discountMinor;
    promoCodeId = discount.promoCodeId;
  }

  // The buyer already cleared the minimum-purchase gate above, so a discount
  // that would otherwise take the order below Razorpay's minimum order
  // amount is clamped rather than rejected outright — the order still goes
  // through, just without discounting past what the provider allows.
  const floorMinor = MIN_ORDER_AMOUNT_MINOR[region];
  if (baseAmountMinor - discountMinor < floorMinor) {
    discountMinor = Math.max(0, baseAmountMinor - floorMinor);
  }

  const amountMinor = baseAmountMinor - discountMinor;

  // notes carry the profile id so a purchase can be traced back from the
  // Razorpay dashboard, but they are NOT the mechanism the webhook uses to
  // attribute the payment — that goes through the payments row written
  // below, which is our own record and cannot be influenced by the client.
  let order;
  try {
    order = await razorpay.orders.create({
      amount: amountMinor,
      currency: pricingRow.currency,
      notes: { profile_id: profileId, credits: String(quantity) },
    });
  } catch {
    // The caught error is deliberately not inspected, forwarded, or logged
    // here: Razorpay error payloads can echo request details and key
    // material, and nothing from them may reach a response body. The route
    // logs a generic failure instead.
    return {
      ok: false,
      reason: "provider_error",
      message: "The payment provider could not create the order",
    };
  }

  // status='created' and signature_verified=false are the honest state right
  // now: an order exists, nothing has been paid, and no signature has been
  // checked. apply_credit_purchase is the only thing that moves either — it
  // runs after the webhook route verifies the signature over the raw body,
  // or after reconcileCreditOrder confirms capture directly with Razorpay.
  const { error: insertError } = await supabaseAdmin.from("payments").insert({
    profile_id: profileId,
    provider: "razorpay",
    provider_order_id: order.id,
    credits_purchased: quantity,
    base_amount_minor: baseAmountMinor,
    discount_minor: discountMinor,
    amount_minor: amountMinor,
    currency: pricingRow.currency,
    promo_code_id: promoCodeId,
    status: "created",
    signature_verified: false,
  });
  if (insertError) {
    throw insertError;
  }

  // RAZORPAY_KEY_ID is the publishable key and is safe to return — it is
  // what Razorpay Checkout's JS widget needs on the frontend. The secret key
  // must never appear in any response body, log line, or error message.
  return {
    ok: true,
    orderId: order.id,
    keyId: env.razorpayKeyId,
    amountMinor,
    currency: pricingRow.currency,
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
  const { data: payment, error: lookupError } = await supabaseAdmin
    .from("payments")
    .select("id, status")
    .eq("provider_order_id", providerOrderId)
    .eq("profile_id", profileId)
    .maybeSingle<{ id: string; status: string }>();

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
