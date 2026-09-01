import { env } from "../lib/env.js";
import { razorpay } from "../lib/razorpay-client.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * The credit packs on sale, keyed by what they top up.
 *
 * Two SKUs, two currencies. `analysis` credits are spent on user-initiated
 * analyses (profiles.credit_balance); `daily_briefing` credits are spent on
 * automated watchlist runs (profiles.daily_briefing_credit_balance). They are
 * deliberately not interchangeable — a briefing run costs us a full model call
 * with no user waiting on it, and letting one balance pay for the other would
 * make either price wrong.
 *
 * A briefing top-up exists because the Daily Briefing add-on is a
 * subscription, and buying that subscription a second time would charge every
 * month while granting nothing: its allowance comes from the plan's
 * daily_briefing_entitlements row, not from a count of subscriptions. Packs
 * stack within a month (10 + 10 + 10); a second subscription cannot.
 *
 * `purpose` is what the webhook routes on, and is stored on the payments row —
 * so these strings are persisted history and must not be reused for a
 * different pack if one is ever repriced.
 *
 * Money is integer minor units (paise), never a float.
 */
const CREDIT_PACKS = {
  analysis: {
    purpose: "credit_pack_10",
    credits: 10,
    amountMinor: 7900,
    currency: "INR",
  },
  daily_briefing: {
    purpose: "daily_briefing_credit_pack_10",
    credits: 10,
    // Priced above the analysis pack: a briefing run renders its own chart and
    // makes the same model call, with no user waiting on the result.
    amountMinor: 9900,
    currency: "INR",
  },
} as const;

/** Which balance a pack tops up. */
export type CreditPackKind = keyof typeof CREDIT_PACKS;

/**
 * Which SQL function grants a captured payment's credits, by the purpose
 * stored on the payments row.
 *
 * The webhook routes on this rather than deciding for itself: the purpose was
 * written when the order was created, so a payment can only ever grant the
 * currency it was sold as, no matter what the webhook payload claims.
 */
export const CREDIT_GRANT_FUNCTION_BY_PURPOSE: Readonly<Record<string, string>> = {
  [CREDIT_PACKS.analysis.purpose]: "apply_credit_purchase",
  [CREDIT_PACKS.daily_briefing.purpose]: "apply_daily_briefing_credit_purchase",
};

export type CreateCreditOrderResult =
  | { ok: true; orderId: string; keyId: string; amountMinor: number }
  | { ok: false; reason: "provider_error"; message: string };

/**
 * Creates a Razorpay Order for one credit pack and records it locally,
 * returning the identifiers Razorpay Checkout needs on the client.
 *
 * Orders are Razorpay's one-time-payment primitive, entirely distinct from the
 * Subscriptions API used for pro_monthly/starter_monthly: no dashboard "Plan"
 * object exists or is needed for a credit pack, and nothing here touches
 * public.subscriptions.
 *
 * Expected outcomes are returned as a discriminated result; only genuinely
 * unexpected failures (DB errors) throw, and the route maps those to 500.
 */
export async function createCreditOrder(
  profileId: string,
  kind: CreditPackKind = "analysis",
): Promise<CreateCreditOrderResult> {
  const pack = CREDIT_PACKS[kind];

  // (a) Create the Razorpay Order.
  //
  // notes carry the profile id so a purchase can be traced back from the
  // Razorpay dashboard, but they are NOT the mechanism the webhook uses to
  // attribute the payment — that goes through the payments row written below,
  // which is our own record and cannot be influenced by the client.
  let order;
  try {
    order = await razorpay.orders.create({
      amount: pack.amountMinor,
      currency: pack.currency,
      notes: { profile_id: profileId, purpose: pack.purpose },
    });
  } catch {
    // The caught error is deliberately not inspected, forwarded, or logged
    // here: Razorpay error payloads can echo request details and key material,
    // and nothing from them may reach a response body. The route logs a
    // generic failure instead.
    return {
      ok: false,
      reason: "provider_error",
      message: "The payment provider could not create the order",
    };
  }

  // (b) Record the pending purchase.
  //
  // status='created' and signature_verified=false are the honest state right
  // now: an order exists, nothing has been paid, and no signature has been
  // checked. The apply_* function this pack's purpose routes to is the only
  // thing that moves either — it runs after the webhook route verifies the
  // signature over the raw body. Credits are granted there and nowhere else.
  const { error: insertError } = await supabaseAdmin.from("payments").insert({
    profile_id: profileId,
    provider: "razorpay",
    provider_order_id: order.id,
    purpose: pack.purpose,
    credits_granted: pack.credits,
    amount_minor: pack.amountMinor,
    currency: pack.currency,
    status: "created",
    signature_verified: false,
  });
  if (insertError) {
    throw insertError;
  }

  // (c) RAZORPAY_KEY_ID is the publishable key and is safe to return — it is
  // what Razorpay Checkout's JS widget needs on the frontend. The secret key
  // must never appear in any response body, log line, or error message.
  return {
    ok: true,
    orderId: order.id,
    keyId: env.razorpayKeyId,
    amountMinor: pack.amountMinor,
  };
}
