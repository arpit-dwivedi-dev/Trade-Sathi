import express, { Router, type Request, type Response } from "express";
import Razorpay from "razorpay";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

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
  async (req: Request, res: Response) => {
    // The exact received bytes, as a string. Deliberately NOT
    // JSON.stringify(JSON.parse(...)): re-serializing a parsed object does not
    // reliably reproduce the original byte sequence (key order, whitespace and
    // escaping can all differ), which makes signature verification fail
    // unpredictably on genuine webhooks. Razorpay's own FAQ warns against it.
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : null;
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
      verified = Razorpay.validateWebhookSignature(
        rawBody,
        signature,
        env.razorpayWebhookSecret,
      );
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

    // Acknowledge and ignore event categories outside this project's current
    // scope (payment.*, order.*, …). This project has no payments or orders
    // tables yet; erroring on them would only make Razorpay retry deliveries
    // that can never be processed.
    if (!eventType.startsWith("subscription.")) {
      logger.info("razorpay webhook ignored: unhandled event type", {
        eventType,
      });
      res.status(200).json({ received: true });
      return;
    }

    const payload = body["payload"] as
      | { subscription?: { entity?: RazorpaySubscriptionEntity } }
      | undefined;
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
      const { data, error } = await supabaseAdmin.rpc(
        "apply_subscription_webhook",
        {
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
        },
      );

      if (error) {
        throw new Error(error.message);
      }

      // All four RPC outcomes are 200. None of them is improved by a Razorpay
      // retry: 'duplicate' and 'stale' are correctly-handled non-actions, and
      // 'subscription_not_found' means the local record does not exist, which
      // redelivering the same event will not change.
      if (data === "subscription_not_found") {
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
          outcome: data,
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
  },
);
