import { env } from "../lib/env.js";
import { razorpay } from "../lib/razorpay-client.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * The one credit pack on sale: 10 credits for ₹79.
 *
 * Hardcoded on purpose while there is exactly one SKU. If a second pack size
 * is added, this should move to a small config object or a database table —
 * not urgent before then, and inventing that indirection now would be the
 * premature abstraction this repo avoids.
 *
 * Money is integer minor units (paise), never a float.
 */
const CREDIT_PACK = {
  purpose: "credit_pack_10",
  credits: 10,
  amountMinor: 7900,
  currency: "INR",
} as const;

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
): Promise<CreateCreditOrderResult> {
  // (a) Create the Razorpay Order.
  //
  // notes carry the profile id so a purchase can be traced back from the
  // Razorpay dashboard, but they are NOT the mechanism the webhook uses to
  // attribute the payment — that goes through the payments row written below,
  // which is our own record and cannot be influenced by the client.
  let order;
  try {
    order = await razorpay.orders.create({
      amount: CREDIT_PACK.amountMinor,
      currency: CREDIT_PACK.currency,
      notes: { profile_id: profileId, purpose: CREDIT_PACK.purpose },
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
  // checked. apply_credit_purchase is the only thing that moves either — it
  // runs after the webhook route verifies the signature over the raw body.
  // Credits are granted there and nowhere else.
  const { error: insertError } = await supabaseAdmin.from("payments").insert({
    profile_id: profileId,
    provider: "razorpay",
    provider_order_id: order.id,
    purpose: CREDIT_PACK.purpose,
    credits_granted: CREDIT_PACK.credits,
    amount_minor: CREDIT_PACK.amountMinor,
    currency: CREDIT_PACK.currency,
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
    amountMinor: CREDIT_PACK.amountMinor,
  };
}
