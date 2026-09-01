import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { createSubscription } from "../services/billing.service.js";
import { createCreditOrder, type CreditPackKind } from "../services/credits.service.js";

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
      const result = await createSubscription(req.profileId!, planKey);

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
          // means a whitelisted plan has no active IN price or no Razorpay plan
          // object — our own configuration problem, and there is nothing the
          // client can do differently.
          logger.error("plan is not purchasable", {
            profileId: req.profileId,
            planKey,
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
 * The credit-pack endpoints. Two SKUs, one handler shape.
 *
 * Daily Briefing top-ups are a one-time Order, NOT a second subscription: the
 * add-on's monthly allowance comes from its plan row, so subscribing twice
 * would bill twice a month and grant nothing. Packs are what stacks within a
 * month.
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
      const result = await createCreditOrder(req.profileId!, kind);

      if (result.ok) {
        res.status(201).json({
          orderId: result.orderId,
          keyId: result.keyId,
          amountMinor: result.amountMinor,
        });
        return;
      }

      switch (result.reason) {
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
