import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { createSubscription } from "../services/billing.service.js";
import { createCreditOrder } from "../services/credits.service.js";

export const billingRouter = Router();

billingRouter.post(
  "/api/billing/subscribe",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const result = await createSubscription(req.profileId!);

      if (result.ok) {
        res
          .status(201)
          .json({ subscriptionId: result.subscriptionId, keyId: result.keyId });
        return;
      }

      switch (result.reason) {
        case "already_subscribed":
          res.status(409).json({ error: result.message });
          return;
        case "plan_unavailable":
          // 500, not 4xx: a missing razorpay_plan_id is our own configuration
          // problem, and there is nothing the client can do differently.
          logger.error("pro_monthly plan is not purchasable", {
            profileId: req.profileId,
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
  },
);

billingRouter.post(
  "/api/billing/buy-credits",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const result = await createCreditOrder(req.profileId!);

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
          });
          res.status(502).json({ error: result.message });
          return;
      }
    } catch (cause) {
      logger.error("failed to create credit order", { cause: String(cause) });
      res.status(500).json({ error: "Failed to create credit order" });
    }
  },
);
