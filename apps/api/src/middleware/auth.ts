import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { supabaseAuth } from "../lib/supabase.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth from the verified JWT's `sub` claim. */
      profileId?: string;
    }
  }
}

const BEARER_PREFIX = "Bearer ";

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

  try {
    const { data, error } = await supabaseAuth.auth.getClaims(token);
    if (error || !data?.claims?.sub) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    req.profileId = data.claims.sub;
  } catch (cause) {
    // getClaims can throw rather than return an error (e.g. JWKS fetch failure);
    // never let that surface as a 500.
    logger.error("jwt verification threw", { cause: String(cause) });
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  next();
}
