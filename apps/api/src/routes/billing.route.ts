import { Router, type Request, type Response } from "express";
import type { PromoRedeemOutcome } from "@chartanalyzer/shared";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { createSubscription } from "../services/billing.service.js";
import { createCreditOrder, type CreditPackKind } from "../services/credits.service.js";
import { ensurePricingRegion } from "../services/pricing-region.service.js";
import { redeemPromoCode } from "../services/promo.service.js";

export const billingRouter = Router();

/**
 * The plan keys a user may purchase through this endpoint today.
 *
 * A hardcoded whitelist on purpose: the set is small and known, and making it
 * dynamic (reading plans/plan_prices) is not warranted yet. 'free' is
 * deliberately absent — it is assigned, never bought.
 */
const PURCHASABLE_PLAN_KEYS = ["starter_monthly", "pro_monthly", "daily_briefing_monthly"] as const;

type PurchasablePlanKey = (typeof PURCHASABLE_PLAN_KEYS)[number];

function isPurchasablePlanKey(value: unknown): value is PurchasablePlanKey {
  return typeof value === "string" && (PURCHASABLE_PLAN_KEYS as readonly string[]).includes(value);
}

billingRouter.post(
  "/api/billing/subscribe",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    try {
      // `?? {}` because a request sent with no body at all leaves req.body
      // undefined, which must be a 400 and not a destructuring TypeError.
      const { planKey } = (req.body ?? {}) as { planKey?: unknown };
      if (!isPurchasablePlanKey(planKey)) {
        res.status(400).json({ error: "Unknown or unpurchasable plan" });
        return;
      }

      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const region = await ensurePricingRegion(req.profileId!, req);
      const result = await createSubscription(req.profileId!, planKey, region);

      if (result.ok) {
        res.status(201).json({ subscriptionId: result.subscriptionId, keyId: result.keyId });
        return;
      }

      switch (result.reason) {
        case "already_subscribed":
          res.status(409).json({ error: result.message });
          return;
        case "plan_unavailable":
          // 500, not 4xx: planKey was already validated above, so reaching here
          // means a whitelisted plan has no active price for this region or no
          // Razorpay plan object — our own configuration problem, and there is
          // nothing the client can do differently.
          logger.error("plan is not purchasable", {
            profileId: req.profileId,
            planKey,
            region,
          });
          res.status(500).json({ error: result.message });
          return;
        case "provider_error":
          // 502: the upstream payment provider failed, which is distinct from a
          // bug on our side.
          logger.error("razorpay subscription creation failed", {
            profileId: req.profileId,
          });
          res.status(502).json({ error: result.message });
          return;
      }
    } catch (cause) {
      logger.error("failed to create subscription", { cause: String(cause) });
      res.status(500).json({ error: "Failed to create subscription" });
    }
  }),
);

/**
 * The credit-pack endpoints. Three SKUs, one handler shape.
 *
 * Daily Briefing top-ups are a one-time Order, NOT a second subscription: the
 * add-on's monthly allowance comes from its plan row, so subscribing twice
 * would bill twice a month and grant nothing. Packs are what stacks within a
 * month.
 *
 * The entry pass is the same Order flow at a once-per-account, region-priced
 * price — see CREDIT_PACKS in credits.service.ts for why it is a pack and not
 * a subscription.
 *
 * The kind is fixed per route rather than read from the body — a client that
 * could name the pack could name the cheaper one and be granted the dearer
 * currency.
 */
function creditPackRoute(kind: CreditPackKind) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const region = await ensurePricingRegion(req.profileId!, req);
      const result = await createCreditOrder(req.profileId!, kind, region);

      if (result.ok) {
        res.status(201).json({
          orderId: result.orderId,
          keyId: result.keyId,
          amountMinor: result.amountMinor,
          currency: result.currency,
        });
        return;
      }

      switch (result.reason) {
        case "pack_unavailable":
          // 400: the pack genuinely is not sold in the caller's region (the
          // INR-only top-ups for a GLOBAL caller). The UI hides those packs,
          // so also seeing this means UI and catalogue drifted — surfaced for
          // the client as a clear no-sale rather than a 500.
          logger.warn("credit pack not available in region", {
            profileId: req.profileId,
            kind,
            region,
          });
          res.status(400).json({ error: result.message });
          return;
        case "already_purchased":
          res.status(409).json({ error: result.message });
          return;
        case "provider_error":
          // 502: the upstream payment provider failed, which is distinct from
          // a bug on our side.
          logger.error("razorpay credit order creation failed", {
            profileId: req.profileId,
            kind,
          });
          res.status(502).json({ error: result.message });
          return;
      }
    } catch (cause) {
      logger.error("failed to create credit order", { kind, cause: String(cause) });
      res.status(500).json({ error: "Failed to create credit order" });
    }
  });
}

billingRouter.post(
  "/api/billing/buy-credits",
  asyncRoute(requireAuth),
  creditPackRoute("analysis"),
);

billingRouter.post(
  "/api/billing/buy-briefing-credits",
  asyncRoute(requireAuth),
  creditPackRoute("daily_briefing"),
);

billingRouter.post(
  "/api/billing/buy-entry-pass",
  asyncRoute(requireAuth),
  creditPackRoute("entry_pass"),
);

/**
 * POST /api/billing/redeem-promo — body { code: string }.
 *
 * All the enforcement lives in redeem_promo_code() (cap, one-per-account,
 * expiry, active) — this route only maps outcomes to statuses. Redemption
 * outcomes are not errors in the 500 sense; they are the user's answer.
 */
const REDEEM_STATUS: Record<Exclude<PromoRedeemOutcome, "applied">, number> = {
  duplicate: 409,
  invalid_code: 404,
  expired: 410,
  exhausted: 409,
};

billingRouter.post(
  "/api/billing/redeem-promo",
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
      const result = await redeemPromoCode(req.profileId!, code.trim());
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
