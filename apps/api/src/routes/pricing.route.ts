import { Router, type Request, type Response } from "express";
import type { PricingOverview } from "@tradesathi/shared";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { verifyAccessToken } from "../middleware/auth.js";
import { getCreditPricing, getFeatureCreditCosts } from "../services/credits.service.js";
import { ensurePricingRegion, regionFromRequest } from "../services/pricing-region.service.js";

export const pricingRouter = Router();

/**
 * GET /api/pricing — public, unauthenticated.
 *
 * The one place a logged-out visitor (the landing pricing section) and a
 * logged-in one both get prices from, so the two can never diverge.
 *
 * Region resolution: an authenticated caller gets their locked
 * profiles.pricing_region (locking it now if this is somehow the first
 * authenticated request); an anonymous caller gets the region derived from
 * this request only — there is no profile to write, and no lock to make.
 */
pricingRouter.get(
  "/api/pricing",
  asyncRoute(async (req: Request, res: Response) => {
    try {
      // Optional auth: same verification requireAuth uses, but a missing or
      // invalid token is not an error here — it just means anonymous pricing.
      const header = req.get("authorization");
      const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
      const profileId = token ? await verifyAccessToken(token) : null;

      const region = profileId
        ? await ensurePricingRegion(profileId, req)
        : regionFromRequest(req).region;

      const [pricing, featureCosts] = await Promise.all([
        getCreditPricing(region),
        getFeatureCreditCosts(),
      ]);

      const body: PricingOverview = { pricing, featureCosts };
      res.json(body);
    } catch (cause) {
      logger.error("failed to serve pricing", { cause: String(cause) });
      res.status(500).json({ error: "Failed to load pricing" });
    }
  }),
);
