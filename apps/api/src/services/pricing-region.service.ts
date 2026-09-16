import type { Request } from "express";
import type { PricingRegion } from "@chartanalyzer/shared";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * Region detection and the one-time region lock.
 *
 * The schema (profiles.detected_country_code / .pricing_region /
 * .pricing_region_source / .pricing_region_locked_at and the pricing_region
 * enum) has existed since 20260830230000; this service is what reads and
 * writes it.
 *
 * Writes go through the service-role client only: those four columns are
 * guarded by Trigger C (protect_profile_columns), which rejects any
 * non-service_role write. There is no SECURITY DEFINER SQL function here for
 * the same reason the entitlement functions avoid DEFINER — under DEFINER,
 * current_user stops being service_role and Trigger C blocks the write.
 */

/**
 * Resolves the caller's country for pricing, in priority order:
 *
 * 1. `CF-IPCountry` — set by Cloudflare when the request passed through it.
 *    Authoritative for that hop and free, so it wins when present.
 * 2. The geoip lookup resolveGeo already attached to req.geo (geoip-lite,
 *    offline, no request-path dependency).
 * 3. Failure → 'IN' with no country recorded. 'IN' is not an arbitrary
 *    default: it is the only region with active, chargeable prices today, so
 *    a failed detection must not strand the user on a price list that cannot
 *    be bought.
 */
export function regionFromRequest(req: Request): {
  region: PricingRegion;
  countryCode: string | null;
} {
  const cfCountry = req.get("cf-ipcountry");
  if (cfCountry && /^[A-Za-z]{2}$/.test(cfCountry)) {
    return {
      region: cfCountry.toUpperCase() === "IN" ? "IN" : "GLOBAL",
      countryCode: cfCountry.toUpperCase(),
    };
  }

  const geoCountry = req.geo?.country;
  if (geoCountry) {
    return {
      region: geoCountry === "IN" ? "IN" : "GLOBAL",
      countryCode: geoCountry,
    };
  }

  return { region: "IN", countryCode: null };
}

/**
 * Profile ids whose pricing_region has already been confirmed non-null by
 * this process. Skips the per-request profiles read once the lock is known to
 * exist — which is forever, because the region is never re-derived.
 *
 * Safe as in-process state because the API is designed to run as exactly one
 * instance (see CLAUDE.md, Operational constraints). It is a cache, not the
 * record: the profiles row is authoritative, so a restart simply re-checks.
 */
const regionConfirmed = new Set<string>();

/**
 * The profile's pricing region, locking it on first sight.
 *
 * Reads profiles.pricing_region. When it is null — the first authenticated
 * request this profile has ever made (or the first since the column was
 * added) — derives the region from the request and writes it with
 * source='geoip' and the lock timestamp, exactly once.
 *
 * The UPDATE is scoped `pricing_region is null`, so two concurrent first
 * requests cannot overwrite each other's region: the second one's update
 * matches zero rows and it simply re-reads the winner. After that the value
 * is never re-derived — a later visit from a different country does not
 * reprice an existing account (by design; see the columns' migration).
 *
 * Never throws: a region-lock failure must not fail the request it rides on,
 * and 'IN' — the fallback with active prices — is always a safe answer.
 */
export async function ensurePricingRegion(
  profileId: string,
  req: Request,
): Promise<PricingRegion> {
  try {
    if (regionConfirmed.has(profileId)) {
      // Known locked — one cheap read to return the actual value, which the
      // caller needs (the Set only records that it exists). A null read here
      // would mean the row went missing after being confirmed non-null, which
      // should not happen; fall back to 'IN' rather than propagate null.
      return (await readRegion(profileId)) ?? "IN";
    }

    const locked = await readRegion(profileId);
    if (locked !== null) {
      regionConfirmed.add(profileId);
      return locked;
    }

    const { region, countryCode } = regionFromRequest(req);

    // Conditional write: only the request that still sees null may set it.
    const { error: updateError } = await supabaseAdmin
      .from("profiles")
      .update({
        detected_country_code: countryCode,
        pricing_region: region,
        pricing_region_source: "geoip",
        pricing_region_locked_at: new Date().toISOString(),
      })
      .eq("id", profileId)
      .is("pricing_region", null);
    if (updateError) {
      throw updateError;
    }

    const confirmed = await readRegion(profileId);
    if (confirmed !== null) {
      regionConfirmed.add(profileId);
      return confirmed;
    }

    // The row was not found at all (an auth.users row without a profile —
    // should not happen, Trigger A creates one on signup). Fall through to
    // the request-derived region rather than erroring.
    return region;
  } catch (cause) {
    logger.warn("pricing region lock failed; falling back to IN", {
      profileId,
      cause: String(cause),
    });
    return "IN";
  }
}

async function readRegion(profileId: string): Promise<PricingRegion | null> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("pricing_region")
    .eq("id", profileId)
    .maybeSingle<{ pricing_region: PricingRegion | null }>();
  if (error) {
    throw error;
  }
  return data?.pricing_region ?? null;
}
