import { env } from "../lib/env.js";
import { razorpay } from "../lib/razorpay-client.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * Subscription statuses that mean "this profile already has a subscription in
 * force, and must not start another checkout". Everything not listed here
 * ('cancelled', 'completed', 'expired') is terminal, and a profile in one of
 * those states may subscribe again.
 *
 * 'created' is deliberately NOT here. It only means a Razorpay subscription
 * object was made and checkout was opened — an abandoned checkout emits no
 * webhook, so such a row would otherwise sit at 'created' forever and lock the
 * user out of ever paying. Those rows are reused instead; see below.
 */
const LIVE_SUBSCRIPTION_STATUSES = [
  "authenticated",
  "active",
  "pending",
  "halted",
  "paused",
] as const;

/**
 * Razorpay's Create Subscription API requires a finite cycle count —
 * total_count is mandatory and there is no "indefinite" option, only a total
 * cycle count or an end date. 1200 is Razorpay's documented convention for a
 * long-lived monthly subscription: (12 * 30) / 1 = 1200 billing cycles.
 * Use exactly this for the MVP; do not derive a different count in code.
 */
const TOTAL_BILLING_CYCLES = 1200;

export type CreateSubscriptionResult =
  | { ok: true; subscriptionId: string; keyId: string }
  | {
      ok: false;
      reason: "already_subscribed" | "plan_unavailable" | "provider_error";
      message: string;
    };

/**
 * Creates a Razorpay Subscription object for the pro_monthly plan and records
 * it locally, returning the identifiers Razorpay Checkout needs on the client.
 *
 * Expected outcomes are returned as a discriminated result; only genuinely
 * unexpected failures (DB errors) throw, and the route maps those to 500.
 */
export async function createSubscription(
  profileId: string,
): Promise<CreateSubscriptionResult> {
  // (a) Reject if this profile already has a non-terminal subscription.
  //
  // This check-then-create flow has a narrow race if the same user submits
  // subscribe concurrently. Two Razorpay subscription objects could be created
  // before either local INSERT lands. This is an accepted MVP limitation; the
  // duplicate objects must be cleaned up if they occur. Do not assume the
  // duplicate can never be authorized or charged.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("profile_id", profileId)
    .in("status", LIVE_SUBSCRIPTION_STATUSES)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw existingError;
  }
  if (existing) {
    return {
      ok: false,
      reason: "already_subscribed",
      message: "This account already has an active or pending subscription",
    };
  }

  // (a2) Reuse a subscription left at 'created' by an abandoned checkout.
  //
  // Razorpay sends no event when a user closes the checkout widget, so the row
  // stays 'created' indefinitely. The Razorpay subscription object is still
  // valid and can be handed back to Checkout, so return it rather than creating
  // a second object (which would leak orphaned subscriptions on every retry).
  const { data: pendingCheckout, error: pendingError } = await supabaseAdmin
    .from("subscriptions")
    .select("provider_subscription_id")
    .eq("profile_id", profileId)
    .eq("status", "created")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingError) {
    throw pendingError;
  }
  if (pendingCheckout?.provider_subscription_id) {
    return {
      ok: true,
      subscriptionId: pendingCheckout.provider_subscription_id,
      keyId: env.razorpayKeyId,
    };
  }

  // (b) Resolve the internal plan and its Razorpay counterpart.
  const { data: plan, error: planError } = await supabaseAdmin
    .from("plans")
    .select("id, razorpay_plan_id, price_inr_paise")
    .eq("key", "pro_monthly")
    .maybeSingle();
  if (planError) {
    throw planError;
  }
  // razorpay_plan_id was set by an earlier migration and should never be null
  // here — but a misconfigured environment is a configuration problem to report,
  // not something to assume away.
  if (!plan?.razorpay_plan_id) {
    return {
      ok: false,
      reason: "plan_unavailable",
      message: "The pro_monthly plan is not available for purchase",
    };
  }

  // (c) Create the Razorpay Subscription object.
  //
  // quantity is omitted deliberately (defaults to 1 — one license per user).
  // No Razorpay Customer object is pre-created: customer_id is populated
  // automatically by Razorpay once the user completes checkout authorization.
  let subscription;
  try {
    subscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpay_plan_id,
      total_count: TOTAL_BILLING_CYCLES,
      customer_notify: 1,
      notes: { profile_id: profileId },
    });
  } catch {
    // The caught error is deliberately not inspected, forwarded, or logged
    // here: Razorpay error payloads can echo request details, and nothing from
    // them may reach a response body. The route logs a generic failure instead.
    return {
      ok: false,
      reason: "provider_error",
      message: "The payment provider could not create the subscription",
    };
  }

  // (d) Record the subscription locally.
  //
  // plan_id is the internal plans.id, not Razorpay's plan_xxx.
  // provider_customer_id stays null — the webhook handler (a separate future
  // task) fills it in once Razorpay populates it post-checkout.
  const { error: insertError } = await supabaseAdmin
    .from("subscriptions")
    .insert({
      profile_id: profileId,
      plan_id: plan.id,
      provider: "razorpay",
      provider_subscription_id: subscription.id,
      status: subscription.status,
      amount_minor: plan.price_inr_paise,
      currency: "INR",
    });
  if (insertError) {
    throw insertError;
  }

  // (e) RAZORPAY_KEY_ID is the publishable key and is safe to return — it is
  // what Razorpay Checkout's JS widget needs on the frontend. The secret key
  // must never appear in any response body, log line, or error message.
  return {
    ok: true,
    subscriptionId: subscription.id,
    keyId: env.razorpayKeyId,
  };
}
