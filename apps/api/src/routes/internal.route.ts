import { Router, type NextFunction, type Request, type Response } from "express";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
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
