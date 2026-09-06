import type { MarketStatus } from "@chartanalyzer/shared";
import { marketDataProvider } from "./market-chart.service.js";

/**
 * The two session schedules the app cares about: Indian exchanges (NSE, BSE
 * share one calendar) and US exchanges (NASDAQ, NYSE share one). One index
 * ticker per group is enough — the regular-session window Yahoo reports is
 * exchange-wide, not per-instrument (see getMarketState).
 */
export const STATUS_MARKETS = ["NSE", "NASDAQ"] as const;
export type StatusMarket = (typeof STATUS_MARKETS)[number];

const REFERENCE_TICKER: Record<StatusMarket, string> = {
  NSE: "^NSEI",
  NASDAQ: "^IXIC",
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<StatusMarket, { status: MarketStatus; expiresAt: number }>();

export function isStatusMarket(value: string): value is StatusMarket {
  return (STATUS_MARKETS as readonly string[]).includes(value);
}

export async function getMarketStatus(market: StatusMarket): Promise<MarketStatus> {
  const hit = cache.get(market);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.status;
  }

  const { isOpen, asOf, nextChangeAt } = await marketDataProvider.getMarketState(
    REFERENCE_TICKER[market],
  );
  const status: MarketStatus = {
    isOpen,
    message: isOpen ? "Market is open" : "Market is closed",
    asOf,
    nextChangeAt,
  };
  // Never cache past a known boundary — a request landing right after
  // regular.end must see 'closed' immediately, not a stale 'open' entry.
  const boundaryMs = nextChangeAt ? new Date(nextChangeAt).getTime() - Date.now() : Infinity;
  cache.set(market, { status, expiresAt: Date.now() + Math.min(CACHE_TTL_MS, boundaryMs) });
  return status;
}
