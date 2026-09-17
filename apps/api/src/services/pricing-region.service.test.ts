import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { env } from "../lib/env.js";
import { regionFromRequest } from "./pricing-region.service.js";

/**
 * Only regionFromRequest is tested here: it is the pure decision (header →
 * region) and every input combination is cheap to construct. ensurePricingRegion
 * is a Supabase-read/write wrapper around it and has no logic worth mocking a
 * client for beyond what the conditional UPDATE already documents.
 */

/** A Request with just the surface regionFromRequest reads: header + req.geo. */
function makeRequest(
  headers: Record<string, string> = {},
  geo?: { country: string | null } | null,
): Request {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  return {
    get: (name: string) => lower[name.toLowerCase()] ?? undefined,
    geo: geo ?? undefined,
  } as unknown as Request;
}

/**
 * CF-IPCountry is only believed when the deployment declares Cloudflare is in
 * front of it, and that flag is read once at module load. Flipping it here is
 * how the two halves of that decision both get exercised; each test that does
 * it restores the previous value so ordering cannot matter.
 */
const originalTrustCfIpCountry = env.trustCfIpCountry;
afterEach(() => {
  env.trustCfIpCountry = originalTrustCfIpCountry;
});

describe("regionFromRequest", () => {
  it("ignores CF-IPCountry by default, because nothing has vouched for it", () => {
    // A plain request header is client-controlled, and this value becomes the
    // account's permanent price band — so `CF-IPCountry: IN` from a caller who
    // simply set the header must not be able to buy at the Indian rate.
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "IN" }, { country: "US" }))).toEqual({
      region: "GLOBAL",
      countryCode: "US",
    });
  });

  it("maps a Cloudflare IN header to the IN region when Cloudflare is trusted", () => {
    env.trustCfIpCountry = true;
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "IN" }))).toEqual({
      region: "IN",
      countryCode: "IN",
    });
  });

  it("maps any other Cloudflare country to GLOBAL, keeping the country code", () => {
    env.trustCfIpCountry = true;
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "US" }))).toEqual({
      region: "GLOBAL",
      countryCode: "US",
    });
  });

  it("accepts a lowercase Cloudflare header value", () => {
    env.trustCfIpCountry = true;
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "in" }))).toEqual({
      region: "IN",
      countryCode: "IN",
    });
  });

  it("ignores a malformed Cloudflare header instead of trusting it", () => {
    // Three letters is not an ISO country code; whatever set it is not
    // Cloudflare's CF-IPCountry, so the value must not reach the region
    // decision.
    env.trustCfIpCountry = true;
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "IND" }, { country: "DE" }))).toEqual({
      region: "GLOBAL",
      countryCode: "DE",
    });
  });

  it("treats Cloudflare's unknown-country codes as no country at all", () => {
    // XX ('cannot place them') and T1 (Tor) are well-formed two-letter values
    // that are not countries. Letting either through would lock the account
    // into a band on the strength of Cloudflare saying it doesn't know —
    // GLOBAL here, and 'IN' if it were treated as the fallback.
    env.trustCfIpCountry = true;
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "XX" }, { country: "US" }))).toEqual({
      region: "GLOBAL",
      countryCode: "US",
    });
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "T1" }))).toEqual({
      region: "GLOBAL",
      countryCode: null,
    });
  });

  it("falls back to the geoip result when Cloudflare is absent", () => {
    expect(regionFromRequest(makeRequest({}, { country: "IN" }))).toEqual({
      region: "IN",
      countryCode: "IN",
    });
    expect(regionFromRequest(makeRequest({}, { country: "GB" }))).toEqual({
      region: "GLOBAL",
      countryCode: "GB",
    });
  });

  it("falls back to GLOBAL with no country when detection has nothing to go on", () => {
    // GLOBAL is the more expensive band, so an unplaceable request can never
    // be the cheap one: making detection fail must not be a way to buy at the
    // Indian rate. ensurePricingRegion additionally refuses to persist this —
    // see the countryCode guard — so it also cannot become permanent.
    expect(regionFromRequest(makeRequest())).toEqual({ region: "GLOBAL", countryCode: null });
    expect(regionFromRequest(makeRequest({}, { country: null }))).toEqual({
      region: "GLOBAL",
      countryCode: null,
    });
  });
});
