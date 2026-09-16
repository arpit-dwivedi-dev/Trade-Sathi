import { describe, expect, it } from "vitest";
import type { Request } from "express";
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

describe("regionFromRequest", () => {
  it("maps a Cloudflare IN header to the IN region", () => {
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "IN" }))).toEqual({
      region: "IN",
      countryCode: "IN",
    });
  });

  it("maps any other Cloudflare country to GLOBAL, keeping the country code", () => {
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "US" }))).toEqual({
      region: "GLOBAL",
      countryCode: "US",
    });
  });

  it("accepts a lowercase Cloudflare header value", () => {
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "in" }))).toEqual({
      region: "IN",
      countryCode: "IN",
    });
  });

  it("ignores a malformed Cloudflare header instead of trusting it", () => {
    // Three letters is not an ISO country code; whatever set it is not
    // Cloudflare's CF-IPCountry, so the value must not reach the region
    // decision.
    expect(regionFromRequest(makeRequest({ "CF-IPCountry": "IND" }, { country: "DE" }))).toEqual({
      region: "GLOBAL",
      countryCode: "DE",
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

  it("falls back to IN with no country when detection has nothing to go on", () => {
    // 'IN' is the only region with active prices today, so a failed detection
    // must land the user on a price list that can actually be bought.
    expect(regionFromRequest(makeRequest())).toEqual({ region: "IN", countryCode: null });
    expect(regionFromRequest(makeRequest({}, { country: null }))).toEqual({
      region: "IN",
      countryCode: null,
    });
  });
});
