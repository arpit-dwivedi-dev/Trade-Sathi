import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { analyzeWatchlistItemNow } from "../services/daily-briefing.service.js";

export const watchlistRouter = Router();

/**
 * "Analyze Now" — a user-triggered, single-symbol run of the same
 * fetch/chart/AI pipeline the daily briefing job uses, gated by the same
 * Daily Briefing entitlement (see analyzeWatchlistItemNow). Everything else
 * about a watchlist item (add/remove/toggle) stays plain client-side CRUD
 * under RLS; this is the one watchlist action that needs server-side work
 * (market data, AI call, quota) and therefore the one watchlist route.
 */
watchlistRouter.post(
  "/api/watchlist/:itemId/analyze-now",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const result = await analyzeWatchlistItemNow(req.profileId!, req.params["itemId"] ?? "");

      if (result.ok) {
        // 202: the pipeline runs in the background (see analyzeWatchlistItemNow's
        // doc comment). The client polls the analyses table directly for a
        // fresh row rather than waiting on this request.
        res.status(202).json({
          instrumentId: result.instrumentId,
          startedAt: result.startedAt,
        });
        return;
      }

      switch (result.reason) {
        case "not_found":
          res.status(404).json({ error: "Watchlist item not found" });
          return;
        case "no_subscription":
          // 402, matching the manual-quota-exceeded convention in
          // analyses.route.ts: this signals "you need the Daily Briefing
          // add-on", not "retry shortly".
          res.status(402).json({ error: "No active Daily Briefing subscription" });
          return;
        case "quota_exhausted":
          res.status(429).json({ error: "Daily Briefing quota exhausted for this period" });
          return;
      }
    } catch (cause) {
      logger.error("analyze-now failed", { cause: String(cause) });
      res.status(500).json({ error: "Analysis failed" });
    }
  },
);
