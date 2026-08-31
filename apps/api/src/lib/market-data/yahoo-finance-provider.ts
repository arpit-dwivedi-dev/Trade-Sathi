import { z } from "zod";
import { logger } from "../logger.js";
import {
  MarketDataError,
  type Candle,
  type HistoricalCandlesParams,
  type MarketDataProvider,
  type Quote,
} from "./types.js";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

// Yahoo's unofficial chart endpoint: { chart: { result: [{ timestamp: number[],
// indicators: { quote: [{ open, high, low, close, volume }] } }], error } }.
// Unofficial and undocumented — validated field-by-field, exactly like the
// Upstox response was, so an upstream shape change surfaces as a clear
// MarketDataError rather than silently wrong numbers reaching a chart or the
// AI model.
const YahooChartResultSchema = z.object({
  meta: z.object({
    regularMarketPrice: z.number().optional(),
    regularMarketTime: z.number().optional(),
  }),
  timestamp: z.array(z.number()),
  indicators: z.object({
    quote: z.array(
      z.object({
        open: z.array(z.number().nullable()),
        high: z.array(z.number().nullable()),
        low: z.array(z.number().nullable()),
        close: z.array(z.number().nullable()),
        volume: z.array(z.number().nullable()),
      }),
    ),
  }),
});

const YahooChartResponseSchema = z.object({
  chart: z.object({
    result: z.array(YahooChartResultSchema).nullable(),
    error: z.object({ code: z.string(), description: z.string() }).nullable(),
  }),
});

type YahooChartResult = z.infer<typeof YahooChartResultSchema>;

function toIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Reads market data from Yahoo Finance's unofficial, undocumented chart API —
 * no API key, no account, no per-user auth. Chosen over Upstox/Dhan/Angel One
 * specifically to avoid any token/account setup; the trade-off (explicit,
 * accepted) is that Yahoo can change or rate-limit this endpoint without
 * notice, same risk class as scraping the NSE website directly, just far less
 * fragile in practice. `instrumentKey` here is a Yahoo ticker symbol (e.g.
 * "RELIANCE.NS", "RELIANCE.BO") built by the caller — see
 * watchlist.service.ts — not an Upstox instrument_key.
 */
export class YahooFinanceMarketDataProvider implements MarketDataProvider {
  /**
   * Shared fetch+validate for Yahoo's chart endpoint — both candle history
   * and a live quote come from the same response shape (`meta` carries the
   * latest price, `indicators.quote` carries OHLCV), so there is exactly one
   * place that talks HTTP to Yahoo and one schema guarding it.
   */
  private async fetchChart(
    instrumentKey: string,
    range: string,
    interval: string,
  ): Promise<YahooChartResult> {
    const url = `${YAHOO_CHART_URL}/${encodeURIComponent(instrumentKey)}?range=${range}&interval=${interval}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          // Yahoo's chart endpoint 429s or 403s a fraction of requests with no
          // User-Agent at all; a plain browser-like UA is the documented
          // community workaround, not a spoofing/evasion measure.
          "User-Agent": "Mozilla/5.0 (compatible; ChartAnalyzer/1.0)",
        },
      });
    } catch (cause) {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance request failed: ${String(cause)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new MarketDataError(
        "auth",
        "Yahoo Finance rejected the request (blocked/rate-limited)",
      );
    }
    if (response.status === 404) {
      throw new MarketDataError(
        "not_found",
        `Yahoo Finance has no chart data for symbol ${instrumentKey}`,
      );
    }
    if (!response.ok) {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance returned HTTP ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance response was not valid JSON: ${String(cause)}`,
      );
    }

    const validation = YahooChartResponseSchema.safeParse(body);
    if (!validation.success) {
      logger.error("yahoo finance chart response failed validation", {
        instrumentKey,
        issues: validation.error.issues.map((i) => i.path.join(".")).join(", "),
      });
      throw new MarketDataError(
        "provider_error",
        "Yahoo Finance response did not match the expected chart schema",
      );
    }

    const { result, error } = validation.data.chart;
    if (error) {
      throw new MarketDataError(
        "not_found",
        `Yahoo Finance error for symbol ${instrumentKey}: ${error.description}`,
      );
    }
    const chartResult = result?.[0];
    if (!chartResult) {
      throw new MarketDataError(
        "not_found",
        `Yahoo Finance returned no chart result for symbol ${instrumentKey}`,
      );
    }

    return chartResult;
  }

  async getHistoricalCandles(params: HistoricalCandlesParams): Promise<Candle[]> {
    const { instrumentKey } = params;

    // Yahoo's chart endpoint takes a range/interval pair, not from/to dates.
    // This pipeline always requests daily candles (unit=days, interval=1) with
    // a ~90-day lookback (see CANDLE_LOOKBACK_DAYS in daily-briefing.service.ts),
    // so "3mo"/"1d" comfortably covers every caller today; if a caller ever
    // needs a different unit/interval this must be revisited rather than
    // silently mismapped.
    if (params.unit !== "days" || params.interval !== 1) {
      throw new MarketDataError(
        "provider_error",
        `YahooFinanceMarketDataProvider only supports unit=days interval=1, got unit=${params.unit} interval=${params.interval}`,
      );
    }

    const chartResult = await this.fetchChart(instrumentKey, "3mo", "1d");

    const quote = chartResult.indicators.quote[0];
    if (!quote) {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance response has no quote data for symbol ${instrumentKey}`,
      );
    }

    const candles: Candle[] = [];
    for (let i = 0; i < chartResult.timestamp.length; i++) {
      const open = quote.open[i];
      const high = quote.high[i];
      const low = quote.low[i];
      const close = quote.close[i];
      const volume = quote.volume[i];
      // Yahoo emits null OHLCV for non-trading days inside the requested
      // range (e.g. a holiday that still gets a timestamp slot) — skip rather
      // than fabricate a candle for a session that never happened.
      if (open == null || high == null || low == null || close == null || volume == null) {
        continue;
      }
      candles.push({
        timestamp: toIsoDate(chartResult.timestamp[i]),
        open,
        high,
        low,
        close,
        volume,
      });
    }

    // Yahoo already returns ascending chronological order, but sort
    // defensively since every downstream consumer depends on that ordering.
    return candles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Live/last-traded price, read from the same chart response's `meta`
   * block — Yahoo doesn't need a separate quote endpoint for this. Not
   * exercised by the daily briefing job today (which uses the last completed
   * daily candle's close as "latest price" — see
   * daily-briefing.service.ts), but implemented for real since nothing about
   * this endpoint requires guessing an undocumented schema, unlike the
   * Upstox quote endpoint this replaces.
   */
  async getQuote(instrumentKey: string): Promise<Quote> {
    const chartResult = await this.fetchChart(instrumentKey, "1d", "1d");
    const { regularMarketPrice, regularMarketTime } = chartResult.meta;

    if (regularMarketPrice == null || regularMarketTime == null) {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance response has no live price for symbol ${instrumentKey}`,
      );
    }

    return {
      instrumentKey,
      lastPrice: regularMarketPrice,
      asOf: new Date(regularMarketTime * 1000).toISOString(),
    };
  }
}
