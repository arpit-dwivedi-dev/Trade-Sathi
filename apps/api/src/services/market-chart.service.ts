import { YahooFinanceMarketDataProvider } from "../lib/market-data/yahoo-finance-provider.js";
import type { Candle, MarketDataProvider, Quote } from "../lib/market-data/types.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { toYahooSymbol } from "./watchlist.service.js";

/**
 * The shared market-data reading layer: everything that turns "an instrument
 * id plus a lookback window" into candles. Both the watchlist/daily-briefing
 * pipeline and the live chart view read through here, so there is exactly one
 * place that decides candle granularity, one provider instance, and one cache
 * in front of the upstream API.
 */

// Upper bound on candles drawn, not on candles fetched: the renderer has a
// fixed 1200px width, and past this the individual candles stop being
// readable (and so stop being analysable). A longer lookback still widens the
// window; it just keeps the most recent MAX_CANDLES_FOR_CHART of it.
export const MAX_CANDLES_FOR_CHART = 250;

export const marketDataProvider: MarketDataProvider = new YahooFinanceMarketDataProvider();

export interface CandleSpec {
  unit: "minutes" | "days";
  interval: number;
  label: string;
}

/**
 * Candle granularity for a chart window. A one-day or one-week window has too
 * few daily candles to read anything from (one, and about five), so short
 * windows are drawn from intraday candles instead. The thresholds are also
 * bounded by the provider: intraday history upstream goes back days, not
 * months, so nothing beyond a week asks for it.
 */
export function candleSpecFor(lookbackDays: number): CandleSpec {
  if (lookbackDays <= 1) return { unit: "minutes", interval: 5, label: "5m" };
  if (lookbackDays <= 7) return { unit: "minutes", interval: 30, label: "30m" };
  return { unit: "days", interval: 1, label: "1D" };
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function subtractDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** An instrument resolved to the identity the market-data provider needs. */
export interface InstrumentRef {
  instrumentId: string;
  instrumentKey: string;
  exchange: string;
  symbol: string;
  name: string;
}

interface InstrumentRow {
  id: string;
  exchange: string;
  symbol: string;
  name: string;
}

/**
 * Resolves an instrument id to a market-data identity. Not profile-scoped:
 * `instruments` is a shared read-only catalogue (the same rows the search
 * endpoint already returns to any authenticated user), so there is no
 * per-user ownership to check here. Returns null when the id is unknown or
 * the exchange has no Yahoo mapping — the caller has nothing to fetch with in
 * either case.
 */
export async function fetchInstrumentById(instrumentId: string): Promise<InstrumentRef | null> {
  const { data, error } = await supabaseAdmin
    .from("instruments")
    .select("id, exchange, symbol, name")
    .eq("id", instrumentId)
    .maybeSingle<InstrumentRow>();

  if (error) throw error;
  if (!data) return null;

  const instrumentKey = toYahooSymbol(data.exchange, data.symbol);
  if (!instrumentKey) return null;

  return {
    instrumentId: data.id,
    instrumentKey,
    exchange: data.exchange,
    symbol: data.symbol,
    name: data.name,
  };
}

/**
 * Short-lived cache in front of the upstream provider. The live chart view
 * polls for fresh candles on a timer and several viewers can be watching the
 * same symbol, so without this a popular instrument would hit the free Yahoo
 * endpoint once per client per poll. TTLs are deliberately shorter than the
 * candle interval they serve, so a cache hit can never hide a closed candle
 * for longer than it takes the next one to form.
 */
const INTRADAY_TTL_MS = 30_000;
const DAILY_TTL_MS = 5 * 60_000;
const cache = new Map<string, { candles: Candle[]; fetchedAt: number }>();

/** Test seam: the cache is process-global, which would otherwise leak between tests. */
export function clearCandleCache(): void {
  cache.clear();
}

export interface CandleWindow {
  candles: Candle[];
  spec: CandleSpec;
  /** Granularity and window together, e.g. "1D · 90d" or "5m · 1d". */
  timeframeLabel: string;
  /** Calendar date of the most recent candle; null when the window is empty. */
  marketDataDate: string | null;
}

/**
 * Candles for one instrument over a lookback window, already trimmed to the
 * window the caller asked for. The provider widens a request to the nearest
 * range its upstream accepts, so anything older than that window is dropped
 * here rather than quietly returned (and drawn).
 *
 * Throws MarketDataError from the provider; callers decide policy.
 */
export async function getCandlesForInstrument(
  ref: InstrumentRef,
  lookbackDays: number,
): Promise<CandleWindow> {
  const spec = candleSpecFor(lookbackDays);
  const toDate = todayIsoDate();
  const fromDate = subtractDays(toDate, lookbackDays);
  const cacheKey = `${ref.instrumentKey}|${spec.unit}|${spec.interval}|${fromDate}|${toDate}`;
  const ttl = spec.unit === "minutes" ? INTRADAY_TTL_MS : DAILY_TTL_MS;

  const cached = cache.get(cacheKey);
  let candles: Candle[];
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    candles = cached.candles;
  } else {
    const fetched = await marketDataProvider.getHistoricalCandles({
      instrumentKey: ref.instrumentKey,
      unit: spec.unit,
      interval: spec.interval,
      toDate,
      fromDate,
    });
    candles = fetched.filter((candle) => candle.timestamp.slice(0, 10) >= fromDate);
    cache.set(cacheKey, { candles, fetchedAt: Date.now() });
  }

  const last = candles[candles.length - 1];
  return {
    candles,
    spec,
    timeframeLabel: `${spec.label} · ${lookbackDays}d`,
    marketDataDate: last ? last.timestamp.slice(0, 10) : null,
  };
}

export async function getQuoteForInstrument(ref: InstrumentRef): Promise<Quote> {
  return marketDataProvider.getQuote(ref.instrumentKey);
}
