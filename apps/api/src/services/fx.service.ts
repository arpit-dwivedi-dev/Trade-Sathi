import type { AdminFx } from "@tradesathi/shared";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * USD→INR for the Admin panel's P&L view, and nothing else: money the app
 * charges is always priced and stored in its own currency, never converted.
 *
 * Frankfurter (open source, no key) serves the European Central Bank's daily
 * reference rates, so a 12-hour cache loses nothing. When it is unreachable
 * the last good rate is kept; with none, ADMIN_USD_INR_RATE is the fallback.
 */
const RATE_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR";
const CACHE_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

let cached: { fx: AdminFx; fetchedAt: number } | null = null;

export async function getUsdInr(now: number = Date.now()): Promise<AdminFx> {
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.fx;

  try {
    const res = await fetch(RATE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { date?: string; rates?: { INR?: number } };
    const rate = body.rates?.INR;
    if (typeof rate !== "number" || rate <= 0) throw new Error("no INR rate in response");
    cached = { fx: { usdInr: rate, asOf: body.date ?? null, source: "ecb" }, fetchedAt: now };
    return cached.fx;
  } catch (cause) {
    logger.warn("usd-inr rate fetch failed", { cause: String(cause) });
    if (cached) return cached.fx;
    return env.adminUsdInrRate
      ? { usdInr: env.adminUsdInrRate, asOf: null, source: "configured" }
      : { usdInr: null, asOf: null, source: null };
  }
}
