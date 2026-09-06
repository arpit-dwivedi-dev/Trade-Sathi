import {
  resolveUpstreamRequest,
  YahooFinanceMarketDataProvider,
} from "../lib/market-data/provider/yahoo-finance-provider.js";
import { getRawStatements } from "../lib/market-data/provider/yahoo-statements.js";
import { getSecEdgarStatements } from "../lib/market-data/provider/sec-edgar-statements.js";
import { getNseStatements } from "../lib/market-data/provider/nse-statements.js";
import { mergeStatementSources } from "../lib/market-data/statements-merge.js";
import type { RawStatements } from "../lib/market-data/statements.js";
import type { ProviderFundamentals } from "../lib/market-data/provider/yahoo-finance-provider.js";
import type { Candle, MarketDataProvider, Quote } from "../lib/market-data/types.js";
import { logger } from "../lib/logger.js";
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

// Concretely typed, `satisfies`-checked against the provider-agnostic
// contract every automated-analysis path depends on: fundamentals are read
// off this same instance (one client, one connection pool, one crumb
// session), and getFundamentals is deliberately not part of that contract —
// it serves one screen, not the analysis pipeline.
export const marketDataProvider = new YahooFinanceMarketDataProvider() satisfies MarketDataProvider;

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
  // 1-minute for the single-day window: this is the one people watch a live
  // price on, and a 5-minute candle only visibly moves a few times an hour —
  // the streamed price was updating a bar that looked static.
  if (lookbackDays <= 1) return { unit: "minutes", interval: 1, label: "1m" };
  if (lookbackDays <= 7) return { unit: "minutes", interval: 30, label: "30m" };
  return { unit: "days", interval: 1, label: "1D" };
}

/**
 * Timeframes the manual charting workspace lets a user pick directly, rather
 * than have derived from a lookback window the way candleSpecFor does above.
 * Bounded to the granularities the Yahoo provider actually supports (see
 * SUPPORTED_MINUTE_INTERVALS in yahoo-finance-provider.ts).
 */
export const WORKSPACE_INTERVALS = ["1m", "5m", "15m", "30m", "60m", "1d"] as const;
export type WorkspaceInterval = (typeof WORKSPACE_INTERVALS)[number];

const WORKSPACE_INTERVAL_SPECS: Record<WorkspaceInterval, CandleSpec> = {
  "1m": { unit: "minutes", interval: 1, label: "1m" },
  "5m": { unit: "minutes", interval: 5, label: "5m" },
  "15m": { unit: "minutes", interval: 15, label: "15m" },
  "30m": { unit: "minutes", interval: 30, label: "30m" },
  "60m": { unit: "minutes", interval: 60, label: "1H" },
  "1d": { unit: "days", interval: 1, label: "1D" },
};

/** The explicit-timeframe counterpart to candleSpecFor, for the workspace view. */
export function explicitCandleSpec(interval: WorkspaceInterval): CandleSpec {
  return WORKSPACE_INTERVAL_SPECS[interval];
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
const DAILY_TTL_MS = 5 * 60_000;
/**
 * Intraday entries expire as a fraction of the candle they serve, not on a
 * fixed timer. A flat 30s was fine for 5-minute candles and far too long for
 * 1-minute ones: the live view refetches the moment a streamed price crosses
 * into a new candle, and a stale entry would answer that request with the
 * candle it already had. Bounded at both ends so a fine granularity cannot
 * turn into a hot loop against the upstream provider.
 */
const INTRADAY_TTL_MIN_MS = 5_000;
const INTRADAY_TTL_MAX_MS = 30_000;

function intradayTtlMs(intervalMinutes: number): number {
  const sixth = (intervalMinutes * 60_000) / 6;
  return Math.min(Math.max(sixth, INTRADAY_TTL_MIN_MS), INTRADAY_TTL_MAX_MS);
}

/** A live price is only ever wanted as "right now", so it gets the floor TTL. */
const QUOTE_TTL_MS = INTRADAY_TTL_MIN_MS;

/**
 * Upper bound on distinct keys held. Candle keys are bounded by
 * (instrument x range x interval) and quote keys by instrument, so this is
 * only reachable across a large catalogue; it exists so a long-running process
 * cannot grow the map without limit. Expired entries are dropped first, and
 * only if that frees nothing is the oldest entry evicted.
 */
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * TTL cache that also collapses concurrent misses. Storing only settled
 * results was not enough: every request arriving while a fetch was in flight
 * missed too and started its own, so each TTL expiry on a symbol several
 * people were watching turned into a burst of identical upstream calls — the
 * very thing that earns the throttling this cache exists to avoid. In-flight
 * promises are shared, and a failed one is evicted so the error is not cached.
 */
class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * @param pruneAfterMs the longest TTL this cache is ever resolved with, so
   * prune() below can tell an entry no caller could still be served from a
   * live one. Defaults to the candle path's longest.
   */
  constructor(private readonly pruneAfterMs: number = DAILY_TTL_MS) {}

  async resolve(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && Date.now() - entry.fetchedAt < ttlMs) return entry.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.entries.set(key, { value, fetchedAt: Date.now() });
        this.prune();
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /**
   * Keys embed a range and interval, not a date, so the map no longer grows a
   * fresh generation of keys every midnight — but entries for instruments
   * nobody looks at again would still be held forever without this.
   */
  private prune(): void {
    if (this.entries.size <= MAX_CACHE_ENTRIES) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      // The longest TTL in use, so this only drops entries no caller could
      // still have served to them.
      if (now - entry.fetchedAt >= this.pruneAfterMs) this.entries.delete(key);
    }
    // Map iterates in insertion order, so the first key is the oldest write.
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Keyed on the request the provider actually makes upstream, not on the
 * caller's window. `toYahooRange` buckets a span into one of a handful of
 * ranges, so a 60-day and a 90-day lookback are the same `range=3mo` fetch;
 * keying on the caller's from/to dates made those two separate entries and
 * two identical upstream calls. The cached candles are therefore the
 * untrimmed upstream response, and each caller trims to its own window below.
 */
const candleCache = new TtlCache<Candle[]>();
const quoteCache = new TtlCache<Quote>();

/**
 * Fundamentals move on a filing calendar, not a candle clock — the ratios
 * behind them are restated quarterly — so this is cached far longer than
 * anything on the candle path. The price fields inside the payload do go
 * stale within the window; that is accepted, because the Fundamentals screen
 * is not a price ticker (the Live tab is) and the alternative is two upstream
 * calls per visitor per visit for figures that did not change.
 */
const FUNDAMENTALS_TTL_MS = 15 * 60_000;
const fundamentalsCache = new TtlCache<ProviderFundamentals>(FUNDAMENTALS_TTL_MS);
/** Raw statements, cached separately: a different upstream shape on the same
 *  terms, read by the analysis pipeline rather than the Fundamentals tab. */
const statementsCache = new TtlCache<RawStatements>(FUNDAMENTALS_TTL_MS);

/** Test seam: the caches are process-global, which would otherwise leak between tests. */
export function clearCandleCache(): void {
  candleCache.clear();
  quoteCache.clear();
  fundamentalsCache.clear();
  statementsCache.clear();
}

export interface CandleWindow {
  candles: Candle[];
  spec: CandleSpec;
  /** Granularity and window together, e.g. "1D · 90d" or "5m · 1d". */
  timeframeLabel: string;
  /**
   * Length of one candle in minutes. Sent to the client so it can tell
   * whether a streamed tick still belongs to the last candle it was given
   * (extend it) or to a candle that has not been fetched yet (leave it to
   * the next poll) — without duplicating candleSpecFor in the browser.
   */
  intervalMinutes: number;
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
  explicitSpec?: CandleSpec,
): Promise<CandleWindow> {
  const spec = explicitSpec ?? candleSpecFor(lookbackDays);
  const toDate = todayIsoDate();
  const fromDate = subtractDays(toDate, lookbackDays);
  const params = {
    instrumentKey: ref.instrumentKey,
    unit: spec.unit,
    interval: spec.interval,
    toDate,
    fromDate,
  };

  const upstream = resolveUpstreamRequest(params);
  const cacheKey = `${ref.instrumentKey}|${upstream.range}|${upstream.interval}`;
  const ttl = spec.unit === "minutes" ? intradayTtlMs(spec.interval) : DAILY_TTL_MS;

  const fetched = await candleCache.resolve(cacheKey, ttl, () =>
    marketDataProvider.getHistoricalCandles(params),
  );

  // Trimming happens per request, not before caching: the shared entry holds
  // the full upstream range, and two callers with different lookbacks inside
  // that range each get their own window from it.
  const candles = fetched.filter((candle) => candle.timestamp.slice(0, 10) >= fromDate);

  const last = candles[candles.length - 1];
  return {
    candles,
    spec,
    timeframeLabel: `${spec.label} · ${lookbackDays}d`,
    intervalMinutes: spec.unit === "minutes" ? spec.interval : spec.interval * 24 * 60,
    marketDataDate: last ? last.timestamp.slice(0, 10) : null,
  };
}

/**
 * The live price, cached on the same terms as candles. This used to go
 * straight to the provider while the candle path was cached, so the quote
 * endpoint the live view polls was one uncached upstream round trip per client
 * per tick — the exact per-client fan-out the candle cache was added to stop.
 */
export async function getQuoteForInstrument(ref: InstrumentRef): Promise<Quote> {
  return quoteCache.resolve(ref.instrumentKey, QUOTE_TTL_MS, () =>
    marketDataProvider.getQuote(ref.instrumentKey),
  );
}

/**
 * Fundamentals for one instrument, cached on the same terms as candles and
 * quotes. Keyed on the Yahoo ticker rather than the instrument id so the NSE
 * and BSE rows for the same ticker are not two upstream reads of the same
 * filings.
 *
 * Throws MarketDataError from the provider; callers decide policy.
 */
/**
 * The RAW financial statements for one instrument, cached on the same terms
 * as the fundamentals payload above.
 *
 * This is what the analysis pipeline reads. getFundamentalsForInstrument
 * below still serves the Fundamentals TAB, which renders the provider's own
 * figures as a data screen — but no report metric is derived from them.
 */
export async function getRawStatementsForInstrument(ref: InstrumentRef): Promise<RawStatements> {
  return statementsCache.resolve(ref.instrumentKey, FUNDAMENTALS_TTL_MS, () =>
    getMultiSourceStatements(ref),
  );
}

interface OfficialSourceAdapter {
  id: "sec-edgar" | "nse-bse";
  fetch(symbol: string): Promise<RawStatements | null>;
}

const SEC_EDGAR_ADAPTER: OfficialSourceAdapter = { id: "sec-edgar", fetch: getSecEdgarStatements };
const NSE_BSE_ADAPTER: OfficialSourceAdapter = { id: "nse-bse", fetch: getNseStatements };

/**
 * Official-filing sources ahead of Yahoo, by exchange. NASDAQ/NYSE route
 * through SEC EDGAR; NSE/BSE route through NSE (BSE-listed symbols are tried
 * against NSE too, best-effort, since most dual-listed large caps share the
 * same trading symbol on both — there is no separate BSE corpfiling client).
 * Any other exchange gets no official source, matching today's Yahoo-only
 * behaviour exactly.
 */
function officialAdaptersFor(exchange: string): OfficialSourceAdapter[] {
  if (exchange === "NASDAQ" || exchange === "NYSE") return [SEC_EDGAR_ADAPTER];
  if (exchange === "NSE" || exchange === "BSE") return [NSE_BSE_ADAPTER];
  return [];
}

/**
 * Official filings first, Yahoo always alongside as the required fallback —
 * merged with official values winning per period. See statements-merge.ts.
 *
 * Yahoo stays a hard dependency exactly as before this fallback chain
 * existed: if it throws, this still throws. Official sources are strictly
 * additive — a failure there is logged and simply leaves fewer periods to
 * prefer, never a new failure mode for the caller.
 */
async function getMultiSourceStatements(ref: InstrumentRef): Promise<RawStatements> {
  const officialAdapters = officialAdaptersFor(ref.exchange);
  const settled = await Promise.allSettled(officialAdapters.map((adapter) => adapter.fetch(ref.symbol)));

  const officialStatements: RawStatements[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value) officialStatements.push(result.value);
    } else {
      logger.warn("official statements source failed", {
        source: officialAdapters[index].id,
        instrumentKey: ref.instrumentKey,
        cause: String(result.reason),
      });
    }
  });

  const yahoo = await getRawStatements(ref.instrumentKey);
  return mergeStatementSources([...officialStatements, yahoo]);
}

export async function getFundamentalsForInstrument(
  ref: InstrumentRef,
): Promise<ProviderFundamentals> {
  return fundamentalsCache.resolve(ref.instrumentKey, FUNDAMENTALS_TTL_MS, () =>
    marketDataProvider.getFundamentals(ref.instrumentKey),
  );
}
