import express, { Router, type Request, type Response } from "express";
import Razorpay from "razorpay";
import { asyncRoute } from "../lib/async-route.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";

export const webhooksRouter = Router();

/**
 * The subset of payload.payment.entity this route reads. Razorpay sends many
 * more fields; only these are consumed, and every one of them is treated as
 * provider-controlled data that may be absent.
 */
interface RazorpayPaymentEntity {
  id?: unknown;
  order_id?: unknown;
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
      // signature must never reach the payments table.
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

    // Every event category besides payment.captured is outside this
    // project's current scope. There are no Razorpay Subscriptions anymore —
    // every purchase is a one-time Order — so payment.captured is the only
    // event this webhook does anything with; acknowledge and ignore the
    // rest (payment.failed, order.*, …). Erroring on them would only make
    // Razorpay retry deliveries that can never be processed.
    logger.info("razorpay webhook ignored: unhandled event type", { eventType });
    res.status(200).json({ received: true });
  }),
);

/**
 * Applies a verified payment.captured event, if and only if it belongs to a
 * credit purchase this backend created an Order for.
 *
 * The discriminator is our own payments table — a row exists only because
 * createCreditOrder wrote one, so its presence, not anything in the
 * provider's payload, decides whether this event is ours at all. A miss is
 * an expected, if rare, case (a stray or test-mode event) and is
 * acknowledged rather than treated as an error.
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
    // The lookup that decides whether this is ours at all.
    const { data: payment, error: lookupError } = await supabaseAdmin
      .from("payments")
      .select("id")
      .eq("provider_order_id", providerOrderId)
      .maybeSingle<{ id: string }>();

    if (lookupError) {
      throw new Error(lookupError.message);
    }

    if (!payment) {
      logger.info("razorpay webhook ignored: no local payment row for order", {
        eventType,
        eventId,
        providerOrderId,
      });
      res.status(200).json({ received: true });
      return;
    }

    const outcome = await callRpc<string>("apply_credit_purchase", {
      p_provider_order_id: providerOrderId,
      p_provider_payment_id: providerPaymentId,
      // Reaching this line means the signature check above passed, so this is
      // the stronger of the two facts a captured row can carry. Stated
      // explicitly because the reconciliation path (POST /api/billing/
      // verify-order) calls the same function having established something
      // different — a live query against Razorpay, not a signature — and
      // recording one as the other would put a falsehood in the audit trail.
      p_signature_verified: true,
    });

    // Every outcome is 200: none of them is improved by a Razorpay retry.
    // 'duplicate' is a correctly-handled non-action, and 'order_not_found'
    // would mean the row vanished between the lookup above and the call,
    // which redelivery will not fix.
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
