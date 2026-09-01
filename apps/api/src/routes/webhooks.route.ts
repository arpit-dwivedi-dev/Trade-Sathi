import express, { Router, type Request, type Response } from "express";
import Razorpay from "razorpay";
import { asyncRoute } from "../lib/async-route.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";
import { CREDIT_GRANT_FUNCTION_BY_PURPOSE } from "../services/credits.service.js";

export const webhooksRouter = Router();

/**
 * The subset of payload.subscription.entity this route reads. Razorpay sends
 * many more fields; only these are consumed, and every one of them is treated
 * as provider-controlled data that may be absent.
 */
interface RazorpaySubscriptionEntity {
  id?: unknown;
  status?: unknown;
  current_start?: unknown;
  current_end?: unknown;
  charge_at?: unknown;
  customer_id?: unknown;
}

/**
 * The subset of payload.payment.entity this route reads. Same treatment as the
 * subscription entity: provider-controlled data that may be absent.
 */
interface RazorpayPaymentEntity {
  id?: unknown;
  order_id?: unknown;
}

/**
 * Converts a Razorpay Unix-seconds timestamp to an ISO-8601 string for a
 * timestamptz parameter.
 *
 * Null is passed through rather than defaulted: current_end and charge_at are
 * legitimately null on some statuses (a fresh 'created' subscription has no
 * current period yet), and substituting any date would fabricate a billing
 * period that does not exist.
 */
function toIsoOrNull(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

webhooksRouter.post(
  "/api/webhooks/razorpay",
  // Raw body parsing, scoped to this path alone rather than applied app-wide.
  //
  // Signature verification must run over the exact bytes Razorpay sent. With
  // express.raw(), req.body is a Buffer of those bytes. Every other route
  // (multer uploads, requireAuth-protected JSON routes) is untouched by this
  // and keeps its normal parsing — see index.ts for the mount ordering that
  // keeps the global express.json() away from this path.
  express.raw({ type: "application/json" }),
  asyncRoute(async (req: Request, res: Response) => {
    // The exact received bytes, as a string. Deliberately NOT
    // JSON.stringify(JSON.parse(...)): re-serializing a parsed object does not
    // reliably reproduce the original byte sequence (key order, whitespace and
    // escaping can all differ), which makes signature verification fail
    // unpredictably on genuine webhooks. Razorpay's own FAQ warns against it.
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : null;
    const signature = req.header("x-razorpay-signature");

    if (rawBody === null || !signature) {
      // Log the fact, never the payload or the secret.
      logger.warn("razorpay webhook rejected: missing raw body or signature");
      res.status(400).json({ error: "Invalid webhook request" });
      return;
    }

    // The SDK's helper rather than a hand-rolled HMAC + `===` comparison: a
    // plain string comparison is not constant-time and leaks signature bytes
    // through timing.
    let verified = false;
    try {
      verified = Razorpay.validateWebhookSignature(rawBody, signature, env.razorpayWebhookSecret);
    } catch {
      // A malformed signature header can make the helper throw; that is a
      // failed verification, not an infrastructure error.
      verified = false;
    }

    if (!verified) {
      // Worth a human noticing: either a misconfigured secret or a spoofed
      // request. Nothing is parsed and nothing is written — an invalid
      // signature must never reach the webhook_events ledger.
      logger.warn("razorpay webhook failed signature verification");
      res.status(400).json({ error: "Invalid webhook signature" });
      return;
    }

    // --- Verified beyond this point. Only now is the body parsed. ---
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      logger.warn("razorpay webhook body is not valid JSON");
      res.status(400).json({ error: "Invalid webhook payload" });
      return;
    }

    const eventType = asStringOrNull(body["event"]);
    // Razorpay's documented identifier for duplicate-delivery detection. It is
    // a header, not a body field, and is distinct from the signature header.
    const eventId = req.header("x-razorpay-event-id");

    if (!eventType || !eventId) {
      logger.warn("razorpay webhook missing event type or event id");
      res.status(400).json({ error: "Invalid webhook payload" });
      return;
    }

    if (eventType === "payment.captured") {
      await handlePaymentCaptured(body, eventType, eventId, res);
      return;
    }

    // Acknowledge and ignore every other event category outside this project's
    // current scope (payment.failed, order.*, …). Erroring on them would only
    // make Razorpay retry deliveries that can never be processed.
    if (!eventType.startsWith("subscription.")) {
      logger.info("razorpay webhook ignored: unhandled event type", {
        eventType,
      });
      res.status(200).json({ received: true });
      return;
    }

    const payload = body["payload"] as
      { subscription?: { entity?: RazorpaySubscriptionEntity } } | undefined;
    const entity = payload?.subscription?.entity;
    const providerSubscriptionId = asStringOrNull(entity?.id);
    const status = asStringOrNull(entity?.status);

    // Shouldn't happen per Razorpay's documented payload shape, but this is
    // data the provider controls — acknowledge rather than crash or retry.
    if (!entity || !providerSubscriptionId || !status) {
      logger.warn("razorpay subscription webhook missing subscription entity", {
        eventType,
        eventId,
      });
      res.status(200).json({ received: true });
      return;
    }

    try {
      const outcome = await callRpc<string>("apply_subscription_webhook", {
        p_event_id: eventId,
        p_event_type: eventType,
        // The envelope's own created_at: when Razorpay generated the event,
        // which is the ordering signal the RPC uses to reject stale
        // deliveries — not when it happened to arrive here.
        p_event_created_at: toIsoOrNull(body["created_at"]),
        p_provider_subscription_id: providerSubscriptionId,
        p_status: status,
        p_current_period_start: toIsoOrNull(entity.current_start),
        p_current_period_end: toIsoOrNull(entity.current_end),
        p_charge_at: toIsoOrNull(entity.charge_at),
        p_provider_customer_id: asStringOrNull(entity.customer_id),
      });

      // All four RPC outcomes are 200. None of them is improved by a Razorpay
      // retry: 'duplicate' and 'stale' are correctly-handled non-actions, and
      // 'subscription_not_found' means the local record does not exist, which
      // redelivering the same event will not change.
      if (outcome === "subscription_not_found") {
        logger.warn("razorpay webhook: no local subscription for event", {
          eventType,
          eventId,
          providerSubscriptionId,
        });
      } else {
        logger.info("razorpay webhook processed", {
          eventType,
          eventId,
          providerSubscriptionId,
          outcome,
        });
      }

      // The outcome is deliberately not revealed in the response body;
      // Razorpay only needs the acknowledgement.
      res.status(200).json({ received: true });
    } catch (cause) {
      // The one case where a retry is genuinely useful: an unexpected
      // infrastructure failure that a later attempt might get past.
      logger.error("razorpay webhook failed to apply", {
        eventType,
        eventId,
        cause: String(cause),
      });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  }),
);

/**
 * Applies a verified payment.captured event, if and only if it belongs to a
 * credit-pack purchase.
 *
 * payment.captured fires for BOTH a one-time credit-pack Order AND every
 * recurring subscription charge. The two must not be confused: a subscription
 * charge is already applied via subscription.charged, and treating it as a
 * credit purchase would grant credits nobody bought. The discriminator is our
 * own payments table — a row exists only because createCreditOrder wrote one,
 * so its presence, not anything in the provider's payload, decides.
 *
 * Called only after signature verification. Always responds; never throws to
 * the caller.
 */
async function handlePaymentCaptured(
  body: Record<string, unknown>,
  eventType: string,
  eventId: string,
  res: Response,
): Promise<void> {
  const payload = body["payload"] as { payment?: { entity?: RazorpayPaymentEntity } } | undefined;
  const entity = payload?.payment?.entity;
  const providerOrderId = asStringOrNull(entity?.order_id);
  const providerPaymentId = asStringOrNull(entity?.id);

  // Shouldn't happen per Razorpay's documented payload shape, but this is data
  // the provider controls — acknowledge rather than crash or retry.
  if (!entity || !providerOrderId || !providerPaymentId) {
    logger.warn("razorpay payment webhook missing payment entity", {
      eventType,
      eventId,
    });
    res.status(200).json({ received: true });
    return;
  }

  try {
    // The lookup that decides whether this is ours at all. A miss is the
    // expected, common case: it means the payment is the side-effect of a
    // subscription charge, already handled through subscription.charged.
    const { data: payment, error: lookupError } = await supabaseAdmin
      .from("payments")
      .select("id, purpose")
      .eq("provider_order_id", providerOrderId)
      .maybeSingle<{ id: string; purpose: string }>();

    if (lookupError) {
      throw new Error(lookupError.message);
    }

    if (!payment) {
      logger.info("razorpay webhook ignored: payment is not a credit purchase", {
        eventType,
        eventId,
        providerOrderId,
      });
      res.status(200).json({ received: true });
      return;
    }

    // Which currency this payment grants is decided by the purpose stored on
    // OUR row when the order was created — never by anything in the webhook
    // payload, which the provider controls. There are two credit currencies
    // (manual analyses and Daily Briefing runs) at different prices, so
    // granting the wrong one would hand out value that was never paid for.
    const grantFunction = CREDIT_GRANT_FUNCTION_BY_PURPOSE[payment.purpose];
    if (!grantFunction) {
      // A payments row exists but its purpose is not a credit pack — a
      // retired SKU, or a purpose added without a grant function. Acknowledge
      // rather than retry: no redelivery makes an unknown purpose known.
      logger.warn("razorpay webhook: payment purpose has no credit grant function", {
        eventType,
        eventId,
        providerOrderId,
        purpose: payment.purpose,
      });
      res.status(200).json({ received: true });
      return;
    }

    const outcome = await callRpc<string>(grantFunction, {
      p_provider_order_id: providerOrderId,
      p_provider_payment_id: providerPaymentId,
    });

    // All outcomes are 200, same policy as the subscription webhook: none of
    // them is improved by a Razorpay retry. 'duplicate' is a correctly-handled
    // non-action, and 'order_not_found' would mean the row vanished between
    // the lookup above and the call, which redelivery will not fix.
    if (outcome === "order_not_found") {
      logger.warn("razorpay webhook: credit payment row disappeared", {
        eventType,
        eventId,
        providerOrderId,
      });
    } else {
      logger.info("razorpay credit purchase webhook processed", {
        eventType,
        eventId,
        providerOrderId,
        outcome,
      });
    }

    // The outcome is deliberately not revealed in the response body; Razorpay
    // only needs the acknowledgement.
    res.status(200).json({ received: true });
  } catch (cause) {
    // The one case where a retry is genuinely useful: an unexpected
    // infrastructure failure that a later attempt might get past.
    logger.error("razorpay credit purchase webhook failed to apply", {
      eventType,
      eventId,
      cause: String(cause),
    });
    res.status(500).json({ error: "Failed to process webhook" });
  }
}
