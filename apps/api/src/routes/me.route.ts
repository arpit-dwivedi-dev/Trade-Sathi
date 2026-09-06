import { Router, type Request, type Response } from "express";
import type { ProfileUpdatePayload } from "@chartanalyzer/shared";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { getProfileDetails, updateProfileDetails } from "../services/profile.service.js";

export const meRouter = Router();

// Lets the frontend confirm a session is still valid, and echoes back the id
// the API resolved it to.
meRouter.get("/api/me", asyncRoute(requireAuth), (req, res) => {
  res.json({ profileId: req.profileId, geo: req.geo ?? null });
});

meRouter.get(
  "/api/me/profile",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    // Non-null: requireAuth ran before this handler and only calls next()
    // after setting profileId.
    const details = await getProfileDetails(req.profileId!);
    if (!details) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }
    res.json(details);
  }),
);

/**
 * Per-field validation for PATCH /api/me/profile. `required: true` (only
 * fullName) rejects an empty string — every other field may be cleared by
 * submitting "". The phone pattern is deliberately loose: it exists to catch
 * garbage input, not to validate a real dialable number across every country
 * format this product might see.
 */
const PROFILE_FIELDS: Record<
  keyof ProfileUpdatePayload,
  { maxLength: number; required?: boolean; pattern?: RegExp }
> = {
  fullName: { maxLength: 120, required: true },
  phoneNumber: { maxLength: 20, pattern: /^[0-9+\-\s()]{6,20}$/ },
  profession: { maxLength: 100 },
  location: { maxLength: 100 },
};

meRouter.patch(
  "/api/me/profile",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: ProfileUpdatePayload = {};

    for (const [key, rule] of Object.entries(PROFILE_FIELDS) as [
      keyof ProfileUpdatePayload,
      (typeof PROFILE_FIELDS)[keyof ProfileUpdatePayload],
    ][]) {
      const raw = body[key];
      if (raw === undefined) continue;

      if (typeof raw !== "string") {
        res.status(400).json({ error: `${key} must be a string` });
        return;
      }
      const trimmed = raw.trim();
      if (rule.required && trimmed.length === 0) {
        res.status(400).json({ error: `${key} must not be empty` });
        return;
      }
      if (trimmed.length > rule.maxLength) {
        res.status(400).json({ error: `${key} must be ${rule.maxLength} characters or fewer` });
        return;
      }
      if (trimmed.length > 0 && rule.pattern && !rule.pattern.test(trimmed)) {
        res.status(400).json({ error: `${key} is not valid` });
        return;
      }
      updates[key] = trimmed;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No profile fields to update" });
      return;
    }

    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      await updateProfileDetails(req.profileId!, updates);
      res.json({ ok: true });
    } catch (cause) {
      logger.error("failed to update profile", { profileId: req.profileId, cause: String(cause) });
      res.status(500).json({ error: "Failed to update profile" });
    }
  }),
);
