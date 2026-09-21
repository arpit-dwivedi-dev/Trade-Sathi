import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/env.js";

/**
 * Whether a verified profile id is one of ADMIN_USER_IDS.
 *
 * Identity is the Supabase Auth user id (the JWT's `sub`, which requireAuth
 * pins onto req.profileId) — never an email, which a user can change and which
 * is not what the token proves.
 */
export function isAdmin(profileId: string | undefined): boolean {
  return profileId !== undefined && env.adminUserIds.has(profileId);
}

/**
 * Gates the admin API. Must run after requireAuth: it trusts only
 * req.profileId, which requireAuth sets from the verified token.
 *
 * A non-admin gets 404 rather than 403, so the admin surface does not announce
 * that it exists to someone probing it.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdmin(req.profileId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}
