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
 *
 * amount and currency are here to be cross-checked against our own payments
 * row — see the check in handlePaymentCaptured. They are not used to decide
 * anything on their own.
 */
interface RazorpayPaymentEntity {
  id?: unknown;
  order_id?: unknown;
  amount?: unknown;
  currency?: unknown;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A minor-unit amount from the provider payload, as a number.
 *
 * Accepts a numeric string as well as a number, because the SDK's own type for
 * a payment amount is `amount: number | string` (razorpay/types/payments.d.ts)
 * — the webhook carries the same payment entity the API returns, so this field
 * genuinely arrives in either encoding. A strict typeof check would fail
 * closed on about half of them and silently refuse a purchase that really did
 * happen.
 *
 * Leniency about the spelling costs nothing: either way the value still has to
 * equal the amount on our own payments row exactly, so there is no value a
 * caller could send that passes one way and not the other. A missing or
 * unparseable field returns null, which matches no amount and refuses the
 * grant.
 */
function asMinorUnitsOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  // Number("") is 0, hence the emptiness check rather than a bare Number().
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
    // The lookup that decides whether this is ours at all. amount_minor and
    // currency come along so what the provider says it captured can be
    // checked against what this order was actually sold as.
    const { data: payment, error: lookupError } = await supabaseAdmin
      .from("payments")
      .select("id, amount_minor, currency")
      .eq("provider_order_id", providerOrderId)
      .maybeSingle<{ id: string; amount_minor: number; currency: string }>();

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

    // A valid signature proves Razorpay sent this event. It does not prove the
    // amount in it is the amount this order was for, and those are different
    // questions: the signature covers the body, so a genuine event for a
    // genuine order can still be a short capture — Razorpay supports capturing
    // less than the order's full value. The payments row is the only thing
    // here that remembers what the buyer was asked to pay, so it is what the
    // captured figure is held against.
    //
    // Refused, and acknowledged with a 200 rather than a 500: nothing about a
    // retry would make the numbers agree, and a 500 here would have Razorpay
    // redeliver an event that will be refused identically every time. Credits
    // are not granted, and the error log is what gets a human to look.
    const capturedAmountMinor = asMinorUnitsOrNull(entity.amount);
    const capturedCurrency = asStringOrNull(entity.currency);
    if (
      capturedAmountMinor !== payment.amount_minor ||
      capturedCurrency !== payment.currency
    ) {
      logger.error("razorpay webhook amount does not match the order; refusing to grant credits", {
        eventType,
        eventId,
        providerOrderId,
        providerPaymentId,
        expectedAmountMinor: payment.amount_minor,
        capturedAmountMinor,
        expectedCurrency: payment.currency,
        capturedCurrency,
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
