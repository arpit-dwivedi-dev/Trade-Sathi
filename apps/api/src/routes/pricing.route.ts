import { Router, type Request, type Response } from "express";
import type { PricingOverview, PublicPlanPrice } from "@chartanalyzer/shared";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { verifyAccessToken } from "../middleware/auth.js";
import { entryPassPriceFor, topUpPackPricesFor } from "../services/credits.service.js";
import { ensurePricingRegion, regionFromRequest } from "../services/pricing-region.service.js";
import { supabaseAdmin } from "../lib/supabase.js";

export const pricingRouter = Router();

/** A plan_prices row joined to its plan, as the query below reads it. */
interface PlanPriceJoinRow {
  amount_minor: number;
  currency: string;
  plans: { key: string; name: string; analyses_per_month: number } | null;
}

/**
 * The manual tiers a public pricing overview advertises.
 *
 * Deliberately narrower than what is purchasable: the free plan has active
 * ₹0/$0 price rows but is not a product to sell — advertising a zero price
 * would read as a tier the paywall no longer grants — and
 * daily_briefing_monthly is an add-on, not a tier; folding it into a tier list
 * is the exact manual-tier/add-on conflation the rest of the billing code is
 * at pains to avoid. Mirrors, rather than shares, PURCHASABLE_PLAN_KEYS in
 * billing.route.ts — same trade as the web's LIVE_SUBSCRIPTION_STATUSES copy.
 */
const PUBLIC_PLAN_KEYS = ["starter_monthly", "pro_monthly"] as const;

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
 *
 * Reads plan_prices for is_active rows only, so a region whose prices are
 * seeded but not yet chargeable (GLOBAL today — its Razorpay plan objects do
 * not exist yet) still lists prices, and purchase attempts correctly fail
 * with 'plan_unavailable' rather than the page showing nothing at all.
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

      const entryPass = entryPassPriceFor(region);
      if (!entryPass) {
        // Every region the product sells in has an entry-pass price; reaching
        // here means the catalogue and the region model have drifted apart.
        res.status(500).json({ error: "Pricing is unavailable" });
        return;
      }

      const { data, error } = await supabaseAdmin
        .from("plan_prices")
        .select("amount_minor, currency, plans!inner(key, name, analyses_per_month)")
        .eq("region", region)
        .eq("is_active", true)
        .in("plans.key", [...PUBLIC_PLAN_KEYS])
        .order("amount_minor", { ascending: true })
        .returns<PlanPriceJoinRow[]>();
      if (error) {
        throw error;
      }

      const plans: PublicPlanPrice[] = (data ?? [])
        .filter((row): row is PlanPriceJoinRow & { plans: NonNullable<PlanPriceJoinRow["plans"]> } =>
          row.plans !== null,
        )
        .map((row) => ({
          key: row.plans.key,
          name: row.plans.name,
          analysesPerMonth: row.plans.analyses_per_month,
          amountMinor: row.amount_minor,
          currency: row.currency,
        }));

      const body: PricingOverview = {
        region,
        plans,
        entryPass,
        // The paid one-off packs, priced from the same catalogue the order
        // endpoints charge from. Only those on sale in this region are listed,
        // so a client decides what to offer from data rather than from the
        // region name — and cannot advertise a pack this API would refuse.
        topUpPacks: topUpPackPricesFor(region),
      };
      res.json(body);
    } catch (cause) {
      logger.error("failed to serve pricing", { cause: String(cause) });
      res.status(500).json({ error: "Failed to load pricing" });
    }
  }),
);
