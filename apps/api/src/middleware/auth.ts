import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { supabaseAuth } from "../lib/supabase.js";
import { ensurePricingRegion } from "../services/pricing-region.service.js";

declare global {
  // Express's own types are declared in the `Express` namespace, so augmenting
  // Request means reopening it — there is no module-syntax equivalent.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth from the verified JWT's `sub` claim. */
      profileId?: string;
    }
  }
}

const BEARER_PREFIX = "Bearer ";

/**
 * Verifies a Supabase access token and returns the profile id it identifies,
 * or null when it is missing/invalid/expired.
 *
 * Split out of requireAuth because the live market-data socket needs the same
 * verification without an Express request: a browser cannot set headers on a
 * WebSocket handshake, so it authenticates with a message instead. Both paths
 * must decide "who is this" identically, so they share this one function.
 */
export async function verifyAccessToken(token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const { data, error } = await supabaseAuth.auth.getClaims(token);
    if (error || !data?.claims?.sub) return null;
    return data.claims.sub;
  } catch (cause) {
    // getClaims can throw rather than return an error (e.g. JWKS fetch failure).
    logger.error("jwt verification threw", { cause: String(cause) });
    return null;
  }
}


/**
 * Verifies the caller's Supabase JWT and pins their identity onto the request.
 *
 * This is cryptographic validation and identity extraction only — it deliberately
 * does not do a live session/revocation check against the Auth server.
 */
// req.profileId is the only trusted source of "who is making this request" anywhere in the API — routes must never read a profile/user id from the request body or query string for authorization decisions.
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.get("authorization");
  if (!header?.startsWith(BEARER_PREFIX)) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const profileId = await verifyAccessToken(token);
  if (!profileId) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  req.profileId = profileId;

  // Fire-and-forget: lock the profile's pricing region on its first
  // authenticated request, without adding a DB round trip to this request's
  // critical path. ensurePricingRegion never throws (it logs and falls back
  // to 'IN'), and its own memo skips work entirely once the region is locked.
  // Called here — not in a route — because requireAuth is the one gate every
  // authenticated request passes, which is what "first authenticated request"
  // means; scoping it to billing routes would leave prices unlocked until a
  // purchase was attempted.
  void ensurePricingRegion(profileId, req);

  next();
}
