import type { Request } from "express";
import type { PricingRegion } from "@tradesathi/shared";
import { env } from "../lib/env.js";
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
 * Two-letter values Cloudflare sends that are not countries: `XX` when it
 * cannot place the caller, `T1` for Tor. Both are well-formed, so the shape
 * check below passes them through — and treating either as a real country
 * would lock the account into a band on the strength of "we don't know",
 * which is exactly what the null-country guard in ensurePricingRegion exists
 * to prevent.
 */
const NON_COUNTRY_CODES: ReadonlySet<string> = new Set(["XX", "T1"]);

/**
 * Resolves the caller's country for pricing, in priority order:
 *
 * 1. `CF-IPCountry` — set by Cloudflare when the request passed through it.
 *    Authoritative for that hop and free, so it wins when present — but only
 *    when the deployment says Cloudflare is actually in front (env
 *    TRUST_CF_IPCOUNTRY). A plain request header is client-controlled, and
 *    this value picks a price band that is then locked forever, so believing
 *    it on the strength of being present was the wrong test: an attacker who
 *    sends `CF-IPCountry: IN` on their first authenticated request paid the
 *    Indian rate for the life of the account.
 * 2. The geoip lookup resolveGeo already attached to req.geo (geoip-lite,
 *    offline, no request-path dependency). That lookup is only as good as the
 *    address it is given, which is why both places that hand it one — index.ts
 *    via `trust proxy`, and geo.ts via req.ip — are load-bearing here.
 * 3. Failure → 'GLOBAL', the *more expensive* band, and no country recorded.
 *    The direction matters: an unplaceable request must never be the cheap
 *    one, or making detection fail would be a way to buy at the Indian rate.
 *    'IN' is only ever reached by actually being in India.
 */
export function regionFromRequest(req: Request): {
  region: PricingRegion;
  countryCode: string | null;
} {
  const cfCountry = env.trustCfIpCountry ? req.get("cf-ipcountry")?.toUpperCase() : null;
  if (
    cfCountry &&
    /^[A-Za-z]{2}$/.test(cfCountry) &&
    !NON_COUNTRY_CODES.has(cfCountry)
  ) {
    return {
      region: cfCountry === "IN" ? "IN" : "GLOBAL",
      countryCode: cfCountry,
    };
  }

  const geoCountry = req.geo?.country;
  if (geoCountry) {
    return {
      region: geoCountry === "IN" ? "IN" : "GLOBAL",
      countryCode: geoCountry,
    };
  }

  return { region: "GLOBAL", countryCode: null };
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
 * source='geoip' and the lock timestamp, exactly once, provided the request
 * actually identified a country. A request that identified nothing gets the
 * fallback region for its own response and leaves the column open; see the
 * countryCode check below.
 *
 * The UPDATE is scoped `pricing_region is null`, so two concurrent first
 * requests cannot overwrite each other's region: the second one's update
 * matches zero rows and it simply re-reads the winner. After that the value
 * is never re-derived — a later visit from a different country does not
 * reprice an existing account (by design; see the columns' migration).
 *
 * Never throws: a region-lock failure must not fail the request it rides on.
 * The 'GLOBAL' fallbacks below are display-only answers for a caller that
 * could not be placed — they are deliberately never written to the profile,
 * and GLOBAL is the more expensive of the two bands, so a failed lookup can
 * neither buy at the cheap rate now nor lock into it for good.
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
      // should not happen; fall back to GLOBAL rather than propagate null, and
      // drop the memo so the next request re-derives instead of trusting it.
      const confirmed = await readRegion(profileId);
      if (confirmed === null) {
        regionConfirmed.delete(profileId);
        return "GLOBAL";
      }
      return confirmed;
    }

    const locked = await readRegion(profileId);
    if (locked !== null) {
      regionConfirmed.add(profileId);
      return locked;
    }

    const { region, countryCode } = regionFromRequest(req);

    // Nothing identified this caller's country, so the region above is the
    // fallback rather than a finding. Serving it for this request is fine —
    // the app needs prices to render — but writing it would make a guess the
    // account's permanent price band.
    //
    // Reachable without any misbehaviour (geoip-lite cannot resolve a private
    // or loopback address, which is what a dev machine looks like), and
    // reachable deliberately by a caller who omits or blanks whatever address
    // the lookup would use. Either way: a request that identified nothing locks
    // nothing, and the account stays open until one that did arrives.
    if (countryCode === null) {
      logger.info("pricing region not locked: no country could be determined", {
        profileId,
      });
      return region;
    }

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
    logger.warn("pricing region lock failed; falling back to GLOBAL", {
      profileId,
      cause: String(cause),
    });
    return "GLOBAL";
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
