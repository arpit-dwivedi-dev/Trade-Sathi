import { Router, type Request, type Response } from "express";
import type { PromoRedeemOutcome } from "@tradesathi/shared";
import { asyncRoute } from "../lib/async-route.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { createCreditOrder, reconcileCreditOrder } from "../services/credits.service.js";
import { ensurePricingRegion } from "../services/pricing-region.service.js";
import { redeemPromoCodeCredits } from "../services/promo.service.js";

export const billingRouter = Router();

/**
 * POST /api/billing/purchase-credits — body { quantity: number, promoCode?: string }.
 *
 * Replaces the old fixed-pack endpoints (buy-credits / buy-briefing-credits /
 * buy-entry-pass): there is one credit balance now, and the buyer picks any
 * quantity at or above the region's minimum rather than choosing among SKUs.
 */
billingRouter.post(
  "/api/billing/purchase-credits",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    // Checked before anything else so no Razorpay order is ever created while
    // purchases are paused — see env.billingEnabled.
    if (!env.billingEnabled) {
      res.status(503).json({
        error: "Purchases are paused during the free beta",
        reason: "billing_disabled",
      });
      return;
    }

    // `?? {}` because a request sent with no body at all leaves req.body
    // undefined, which must be a 400 and not a destructuring TypeError.
    const { quantity, promoCode } = (req.body ?? {}) as {
      quantity?: unknown;
      promoCode?: unknown;
    };

    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
      res.status(400).json({ error: "quantity must be a positive integer" });
      return;
    }
    if (promoCode !== undefined && promoCode !== null) {
      if (typeof promoCode !== "string" || promoCode.trim().length > 64) {
        res.status(400).json({ error: "promoCode must be a string of at most 64 characters" });
        return;
      }
    }

    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const region = await ensurePricingRegion(req.profileId!, req);
      const result = await createCreditOrder(
        req.profileId!,
        region,
        quantity,
        typeof promoCode === "string" ? promoCode : null,
      );

      if (result.ok) {
        res.status(201).json({
          orderId: result.orderId,
          keyId: result.keyId,
          amountMinor: result.amountMinor,
          currency: result.currency,
          creditsRequested: result.creditsRequested,
        });
        return;
      }

      switch (result.reason) {
        case "below_minimum_purchase":
        case "above_maximum_purchase":
        case "invalid_quantity_step":
        case "invalid_promo_code":
          // `reason` travels alongside `error` so the client can branch on it
          // directly (e.g. clear only the promo field on invalid_promo_code)
          // rather than pattern-matching the human-readable message.
          res.status(400).json({ error: result.message, reason: result.reason });
          return;
        case "region_unavailable":
          // 400: the region genuinely has no active pricing row. The UI reads
          // its quantities/prices from GET /api/pricing, so also seeing this
          // means that response and this endpoint have drifted apart.
          logger.warn("credit purchase attempted in a region with no active pricing", {
            profileId: req.profileId,
            region,
          });
          res.status(400).json({ error: result.message, reason: result.reason });
          return;
        case "provider_error":
          // 502: the upstream payment provider failed, which is distinct from
          // a bug on our side.
          logger.error("razorpay credit order creation failed", {
            profileId: req.profileId,
          });
          res.status(502).json({ error: result.message });
          return;
      }
    } catch (cause) {
      logger.error("failed to create credit order", { cause: String(cause) });
      res.status(500).json({ error: "Failed to create credit order" });
    }
  }),
);

/**
 * POST /api/billing/verify-order — body { orderId: string }.
 *
 * "I think I paid for this order — please check." Called by the client when the
 * payments row it has been polling has not flipped to 'captured', which in
 * practice means the Razorpay webhook has not arrived: it is a push with no
 * delivery guarantee, and it cannot reach a local dev server at all.
 *
 * Answers 200 for both settled and not-yet-paid, because neither is an error:
 * the purchase either happened or it hasn't. Only a provider outage (502) or a
 * failure on our side (500) is an error status.
 */
billingRouter.post(
  "/api/billing/verify-order",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    const { orderId } = (req.body ?? {}) as { orderId?: unknown };
    // Bounded because it is used as a query value against our own table and
    // forwarded to the provider; Razorpay's order ids are far shorter than this.
    if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 64) {
      res.status(400).json({ error: "orderId must be a non-empty string" });
      return;
    }

    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const result = await reconcileCreditOrder(req.profileId!, orderId);

      if (result.ok) {
        res.json({ status: "captured" });
        return;
      }

      switch (result.reason) {
        case "not_paid":
          res.json({ status: "pending" });
          return;
        case "not_found":
          // No such order for this profile. Not a 500: the client is asking
          // about something that isn't ours, or isn't an order of theirs.
          logger.warn("verify-order: no matching payment row", {
            profileId: req.profileId,
          });
          res.status(404).json({ error: "No such order" });
          return;
        case "provider_error":
          // 502, distinct from a bug on our side: Razorpay could not be reached
          // or refused the query. The client keeps the purchase unconfirmed.
          logger.error("razorpay order lookup failed during reconciliation", {
            profileId: req.profileId,
          });
          res.status(502).json({ error: "Payment provider unavailable" });
          return;
      }
    } catch (cause) {
      logger.error("failed to verify order", {
        profileId: req.profileId,
        cause: String(cause),
      });
      res.status(500).json({ error: "Failed to verify order" });
    }
  }),
);

/**
 * POST /api/billing/redeem — body { code: string }.
 *
 * All the enforcement lives in redeem_promo_code_credits() (cap, per-account
 * limit, expiry, region eligibility, active) — this route only maps outcomes
 * to statuses. Redemption outcomes are not errors in the 500 sense; they are
 * the user's answer.
 */
const REDEEM_STATUS: Record<Exclude<PromoRedeemOutcome, "applied">, number> = {
  duplicate: 409,
  invalid_code: 404,
  expired: 410,
  exhausted: 409,
  not_eligible_region: 400,
};

billingRouter.post(
  "/api/billing/redeem",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== "string" || code.trim().length === 0 || code.trim().length > 64) {
      res.status(400).json({ error: "code must be a non-empty string" });
      return;
    }

    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const region = await ensurePricingRegion(req.profileId!, req);
      const result = await redeemPromoCodeCredits(req.profileId!, code.trim(), region);
      if (result.ok) {
        res.json({ outcome: "applied" });
        return;
      }
      res.status(REDEEM_STATUS[result.outcome]).json({ outcome: result.outcome });
    } catch (cause) {
      logger.error("failed to redeem promo code", {
        profileId: req.profileId,
        cause: String(cause),
      });
      res.status(500).json({ error: "Failed to redeem promo code" });
    }
  }),
);
