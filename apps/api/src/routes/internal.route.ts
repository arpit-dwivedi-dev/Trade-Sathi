import { Router, type NextFunction, type Request, type Response } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";
import {
  runDailyBriefingForAllUsers,
  runDailyBriefingForUser,
} from "../services/daily-briefing.service.js";

export const internalRouter = Router();

/**
 * There is no admin-role system in this project yet, so a shared secret is
 * the entire access control for this router. Never route real user traffic
 * through here, and never accept this token from anywhere but a trusted
 * operator's request header.
 */
function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.get("x-internal-token");
  if (!token || token !== env.internalOpsToken) {
    res.status(401).json({ error: "Invalid or missing internal token" });
    return;
  }
  next();
}

// Manual trigger for ops testing of the daily briefing job — the "keep/use
// the existing internal manual trigger endpoint" requirement, built fresh
// since none existed. Runs for every eligible profile, or a single one when
// profileId is supplied, so a specific test user's flow can be exercised
// without waiting for the scheduler or affecting every other user.
//
// Fire-and-forget, which is what the 202 below actually promises: a full run
// is 20-30s+ of market-data and AI work PER eligible profile, so awaiting it
// would hold the request open for minutes and any proxy in front of the API
// would drop it — the operator would see a connection error for a run that
// actually succeeded, and might re-trigger it. Outcomes are already logged by
// the job itself; check the logs (or daily_briefing_log) for the result.
internalRouter.post(
  "/api/internal/daily-briefing/run",
  requireInternalToken,
  (req: Request, res: Response) => {
    const body: unknown = req.body;
    const rawProfileId =
      typeof body === "object" && body !== null
        ? (body as { profileId?: unknown }).profileId
        : undefined;
    const profileId = typeof rawProfileId === "string" ? rawProfileId : undefined;

    const run = profileId
      ? runDailyBriefingForUser(profileId)
      : runDailyBriefingForAllUsers();

    void run.catch((cause: unknown) => {
      logger.error("manual daily briefing trigger failed", {
        profileId: profileId ?? "all",
        cause: String(cause),
      });
    });

    res.status(202).json({ status: "triggered", profileId: profileId ?? "all" });
  },
);

/**
 * Promo-code management, behind the same shared-secret gate as the daily
 * briefing trigger above. Deliberately minimal — this is not an admin panel,
 * just enough for the product owner to create, list, and deactivate/adjust a
 * code without raw SQL, matching the level of tooling INTERNAL_OPS_TOKEN
 * already gates elsewhere in this router.
 */

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface PromoCodeCreateBody {
  code?: unknown;
  freeCredits?: unknown;
  discountPercent?: unknown;
  discountFixedMinor?: unknown;
  maxDiscountAmountMinor?: unknown;
  minPurchaseAmountMinor?: unknown;
  maxRedemptions?: unknown;
  perUserLimit?: unknown;
  regionEligibility?: unknown;
  startsAt?: unknown;
  expiresAt?: unknown;
}

// POST /api/internal/promo-codes — create a code. free_credits and/or a
// discount (discountPercent XOR discountFixedMinor) come straight off the
// body; promo_codes' own check constraints (has_an_effect, one_discount_mode)
// are the real validation, so a malformed combination surfaces as a 500 with
// the constraint violation logged rather than being re-validated here.
internalRouter.post(
  "/api/internal/promo-codes",
  requireInternalToken,
  asyncRoute(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as PromoCodeCreateBody;
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) {
      res.status(400).json({ error: "code is required" });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("promo_codes")
      .insert({
        code,
        free_credits: numberOrNull(body.freeCredits),
        discount_percent: numberOrNull(body.discountPercent),
        discount_fixed_minor: numberOrNull(body.discountFixedMinor),
        max_discount_amount_minor: numberOrNull(body.maxDiscountAmountMinor),
        min_purchase_amount_minor: numberOrNull(body.minPurchaseAmountMinor),
        max_redemptions: numberOrNull(body.maxRedemptions),
        per_user_limit: numberOrNull(body.perUserLimit) ?? 1,
        region_eligibility: Array.isArray(body.regionEligibility) ? body.regionEligibility : null,
        starts_at: typeof body.startsAt === "string" ? body.startsAt : null,
        expires_at: typeof body.expiresAt === "string" ? body.expiresAt : null,
      })
      .select("id")
      .single<{ id: string }>();

    if (error) {
      logger.error("failed to create promo code", { cause: String(error) });
      res.status(500).json({ error: "Failed to create promo code" });
      return;
    }

    res.status(201).json({ id: data.id });
  }),
);

// GET /api/internal/promo-codes — list, newest first. No pagination: this is
// an operator tool, not a public listing, and the table is expected to stay
// small.
internalRouter.get(
  "/api/internal/promo-codes",
  requireInternalToken,
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await supabaseAdmin
      .from("promo_codes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      logger.error("failed to list promo codes", { cause: String(error) });
      res.status(500).json({ error: "Failed to list promo codes" });
      return;
    }

    res.json({ promoCodes: data ?? [] });
  }),
);

// PATCH /api/internal/promo-codes/:id — the narrow set of fields an operator
// actually needs to adjust after a code is live: deactivate it, tighten its
// cap, or change/clear its expiry. Anything else (the discount shape itself,
// region eligibility) is create-only; get it right at creation or make a new
// code.
internalRouter.patch(
  "/api/internal/promo-codes/:id",
  requireInternalToken,
  asyncRoute(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      isActive?: unknown;
      maxRedemptions?: unknown;
      expiresAt?: unknown;
    };
    const updates: Record<string, unknown> = {};
    if (typeof body.isActive === "boolean") {
      updates["is_active"] = body.isActive;
    }
    if (body.maxRedemptions === null || typeof body.maxRedemptions === "number") {
      updates["max_redemptions"] = body.maxRedemptions;
    }
    if (body.expiresAt === null || typeof body.expiresAt === "string") {
      updates["expires_at"] = body.expiresAt;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updatable fields provided" });
      return;
    }

    const { error } = await supabaseAdmin
      .from("promo_codes")
      .update(updates)
      .eq("id", req.params["id"] ?? "");

    if (error) {
      logger.error("failed to update promo code", { cause: String(error) });
      res.status(500).json({ error: "Failed to update promo code" });
      return;
    }

    res.status(204).end();
  }),
);
