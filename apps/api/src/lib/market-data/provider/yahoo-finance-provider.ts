import { z } from "zod";
import type { FundamentalsAnnualPeriod, InstrumentFundamentals } from "@chartanalyzer/shared";
import { logger } from "../../logger.js";
import {
  fetchYahoo,
  getCrumbSession,
  invalidateCrumbSession,
  readEpochSeconds,
  readNumber,
  readString,
  readYahooJson,
  TIMESERIES_PERIOD1,
  TIMESERIES_PERIOD2,
  YAHOO_QUOTE_SUMMARY_URL,
  YAHOO_TIMESERIES_URL,
} from "./yahoo-http.js";

import {
  MarketDataError,
  type Candle,
  type HistoricalCandlesParams,
  type MarketDataProvider,
  type Quote,
} from "../types.js";

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

function toIsoTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Yahoo's chart endpoint takes a range/interval pair rather than from/to
 * dates, so the requested span is widened to the nearest range Yahoo accepts
 * and the caller trims the surplus. Intraday intervals have their own, much
 * shorter history limits upstream (minute data goes back days, not months);
 * the ranges paired with them here stay inside those limits.
 */
function toYahooRange(spanDays: number): string {
  if (spanDays <= 1) return "1d";
  if (spanDays <= 5) return "5d";
  if (spanDays <= 30) return "1mo";
  if (spanDays <= 90) return "3mo";
  if (spanDays <= 180) return "6mo";
  return "1y";
}

// 1m and 2m are Yahoo's finest intervals and carry the shortest history
// upstream (a few days); toYahooRange never pairs them with a range past that.
const SUPPORTED_MINUTE_INTERVALS = [1, 2, 5, 15, 30, 60];

function toYahooInterval(unit: HistoricalCandlesParams["unit"], interval: number): string {
  if (unit === "days" && interval === 1) return "1d";
  if (unit === "minutes" && SUPPORTED_MINUTE_INTERVALS.includes(interval)) {
    return `${interval}m`;
  }
  throw new MarketDataError(
    "provider_error",
    `YahooFinanceMarketDataProvider supports unit=days interval=1 or unit=minutes interval=${SUPPORTED_MINUTE_INTERVALS.join("/")}, got unit=${unit} interval=${interval}`,
  );
}

function spanInDays(toDate: string, fromDate?: string): number {
  if (!fromDate) return 90;
  const ms = Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return 90;
  return Math.max(1, Math.round(ms / 86_400_000));
}

/**
 * The (range, interval) pair Yahoo is actually asked for. Several distinct
 * caller windows collapse onto one upstream request — a 60-day and a 90-day
 * lookback are both `range=3mo&interval=1d` — so this is what the caller's
 * cache should be keyed on, not the caller's own from/to dates.
 */
export interface UpstreamChartRequest {
  range: string;
  interval: string;
}

export function resolveUpstreamRequest(params: HistoricalCandlesParams): UpstreamChartRequest {
  return {
    range: toYahooRange(spanInDays(params.toDate, params.fromDate)),
    interval: toYahooInterval(params.unit, params.interval),
  };
}

/**
 * The quoteSummary modules the fundamentals contract is built from. One
 * request covers all of them, so the whole tab is a single upstream call:
 * `price` and `summaryDetail` for the snapshot, `defaultKeyStatistics` and
 * `summaryDetail` for valuation, `financialData` for margins/returns/balance
 * sheet, `summaryProfile` for sector and industry.
 */
const QUOTE_SUMMARY_MODULES = [
  "price",
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
  "summaryProfile",
] as const;

/**
 * The annual series behind the financial-history chart and table. These come
 * from a different endpoint to quoteSummary (fundamentals-timeseries), which
 * needs no cookie or crumb at all.
 */
const ANNUAL_TIMESERIES_TYPES = [
  "annualTotalRevenue",
  "annualOperatingIncome",
  // Attributable to common shareholders (minority interest excluded), not
  // plain "annualNetIncome" — matching the basis quoteSummary's
  // netIncomeToCommon already gives health.netIncome (TTM) below. Yahoo
  // reports both as distinct series; using the mismatched one here would
  // silently mix accounting bases between the TTM and annual figures for
  // any company where minority interest is non-trivial.
  "annualNetIncomeCommonStockholders",
  "annualDilutedEPS",
  "annualOperatingCashFlow",
  "annualFreeCashFlow",
] as const;

type AnnualTimeseriesType = (typeof ANNUAL_TIMESERIES_TYPES)[number];

/**
 * The TTM cash-flow figures, fetched from the same timeseries endpoint as a
 * fallback for health.operatingCashflow/freeCashflow: quoteSummary's own
 * financialData module frequently reports these two fields as null for
 * NSE-listed companies even though the underlying filings have them (verified
 * against Apollo Hospitals and Vodafone Idea) — the timeseries endpoint has
 * them under a differently-named type. Requested together with
 * ANNUAL_TIMESERIES_TYPES in one call; kept as a separate list only because
 * they are read back into a different part of the payload (health.*, not
 * annual[]) and TRAILING_CASHFLOW_STALE_CUTOFF_YEARS below applies to these
 * two only.
 */
const TRAILING_CASHFLOW_TYPES = ["trailingOperatingCashFlow", "trailingFreeCashFlow"] as const;

type TrailingCashflowType = (typeof TRAILING_CASHFLOW_TYPES)[number];

/** The most recent point of a trailing-cashflow series, or null if the
 *  series came back empty. */
type TrailingCashflowPoint = { value: number; asOfDate: string } | null;

/**
 * A trailing cash-flow point is only trustworthy as a stand-in for
 * health.operatingCashflow/freeCashflow when it is not itself stale — Yahoo's
 * "trailing" cash-flow series can freeze years behind the rest of a
 * company's data (observed on Vodafone Idea: latest trailing point 2020-09,
 * while the same request's annual series and quoteSummary were both current
 * to FY2026). Gated on the same 12-month threshold the prompt's own
 * STALENESS section uses as its "low confidence" cutoff — past that, the
 * annual series (also carried in the payload) is the better evidence than a
 * silently-stale trailing figure.
 */
const TRAILING_CASHFLOW_STALE_MS = 366 * 24 * 60 * 60 * 1000;

function usableTrailingCashflow(point: TrailingCashflowPoint): number | null {
  if (point === null) return null;
  const ageMs = Date.now() - new Date(point.asOfDate).getTime();
  if (Number.isNaN(ageMs) || ageMs > TRAILING_CASHFLOW_STALE_MS) return null;
  return point.value;
}


// The module bodies are read through readNumber/readString above, so the
// schema's job here is the envelope: that a result came back at all, and that
// each module is an object rather than, say, a string.
const YahooQuoteSummaryResponseSchema = z.object({
  quoteSummary: z.object({
    result: z.array(z.record(z.string(), z.record(z.string(), z.unknown()))).nullable(),
    error: z.object({ code: z.string(), description: z.string() }).nullable(),
  }),
});

const YahooTimeseriesResponseSchema = z.object({
  timeseries: z.object({
    result: z
      .array(
        z
          .object({
            meta: z.object({ type: z.array(z.string()) }),
          })
          // Each result carries its series under a key named by its own type,
          // so the payload key is dynamic and cannot be named in the schema.
          .catchall(z.unknown()),
      )
      .nullable(),
    error: z.unknown().nullable(),
  }),
});

/** One `{ asOfDate, reportedValue: { raw } }` entry of a timeseries result. */
function readTimeseriesPoints(
  result: { meta: { type: string[] } } & Record<string, unknown>,
): Map<string, number> {
  const type = result.meta.type[0];
  const points = new Map<string, number>();
  const series = type === undefined ? undefined : result[type];
  if (!Array.isArray(series)) return points;

  for (const entry of series) {
    // Yahoo pads a series with nulls for periods it has no filing for.
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const asOfDate = row["asOfDate"];
    const value = readNumber(row, "reportedValue");
    if (typeof asOfDate === "string" && value !== null) points.set(asOfDate, value);
  }
  return points;
}

/**
 * Everything the fundamentals contract holds except the instrument identity,
 * which the provider is given as a ticker and never resolves back to a
 * catalogue row — the service layer adds it.
 */
export type ProviderFundamentals = Omit<InstrumentFundamentals, "instrument">;

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

    const response = await fetchYahoo(url, instrumentKey);

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

    const validation = YahooChartResponseSchema.safeParse(
      await readYahooJson(response, instrumentKey),
    );
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

    // The requested window is honoured, not assumed: a watchlist item carries
    // its own chart window (a day of 5-minute candles, a year of daily ones),
    // and this used to hardcode "3mo"/"1d" — every longer window silently got
    // three months of data.
    const { range, interval } = resolveUpstreamRequest(params);
    const intraday = params.unit === "minutes";

    const chartResult = await this.fetchChart(instrumentKey, range, interval);

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
        // Intraday candles keep their time-of-day: several candles share one
        // calendar date, so a date-only stamp would collapse them.
        timestamp: intraday
          ? toIsoTimestamp(chartResult.timestamp[i])
          : toIsoDate(chartResult.timestamp[i]),
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

  /**
   * Fundamentals for one symbol: the valuation, margin and balance-sheet
   * figures behind the Fundamentals tab, plus the annual revenue/earnings
   * history the chart and table there are drawn from.
   *
   * Two upstream calls, run together — quoteSummary for everything as-of-now
   * and fundamentals-timeseries for the yearly history. They are separate
   * endpoints with separate auth (see getCrumbSession) and there is no single
   * endpoint that carries both.
   *
   * `instrumentKey` is a Yahoo ticker, exactly as for the chart methods.
   */
  async getFundamentals(instrumentKey: string): Promise<ProviderFundamentals> {
    const [modules, timeseries] = await Promise.all([
      this.fetchQuoteSummary(instrumentKey),
      // The history is the one part of this screen that is not worth failing
      // the whole request over: the figures above it stand on their own, and
      // this endpoint is the flakier of the two.
      this.fetchAnnualSeries(instrumentKey).catch((cause: unknown) => {
        logger.warn("yahoo finance annual fundamentals unavailable", {
          instrumentKey,
          cause: String(cause),
        });
        return {
          annual: [] as FundamentalsAnnualPeriod[],
          trailingOperatingCashflow: null as TrailingCashflowPoint,
          trailingFreeCashflow: null as TrailingCashflowPoint,
        };
      }),
    ]);
    const { annual } = timeseries;

    const price = modules["price"];
    const detail = modules["summaryDetail"];
    const stats = modules["defaultKeyStatistics"];
    const financials = modules["financialData"];
    const profile = modules["summaryProfile"];

    return {
      meta: {
        currency: readString(price, "currency"),
        financialCurrency: readString(financials, "financialCurrency"),
        asOf: readEpochSeconds(price, "regularMarketTime"),
        mostRecentQuarter: readEpochSeconds(stats, "mostRecentQuarter")?.slice(0, 10) ?? null,
      },
      profile: {
        sector: readString(profile, "sectorDisp") ?? readString(profile, "sector"),
        industry: readString(profile, "industryDisp") ?? readString(profile, "industry"),
        employees: readNumber(profile, "fullTimeEmployees"),
        website: readString(profile, "website"),
        summary: readString(profile, "longBusinessSummary"),
      },
      snapshot: {
        price: readNumber(price, "regularMarketPrice") ?? readNumber(financials, "currentPrice"),
        change: readNumber(price, "regularMarketChange"),
        // Yahoo reports this one as a percentage-as-fraction already.
        changePercent: readNumber(price, "regularMarketChangePercent"),
        previousClose: readNumber(price, "regularMarketPreviousClose"),
        dayLow: readNumber(price, "regularMarketDayLow"),
        dayHigh: readNumber(price, "regularMarketDayHigh"),
        fiftyTwoWeekLow: readNumber(detail, "fiftyTwoWeekLow"),
        fiftyTwoWeekHigh: readNumber(detail, "fiftyTwoWeekHigh"),
        fiftyDayAverage: readNumber(detail, "fiftyDayAverage"),
        twoHundredDayAverage: readNumber(detail, "twoHundredDayAverage"),
        volume: readNumber(price, "regularMarketVolume"),
        averageVolume: readNumber(detail, "averageVolume"),
        marketCap: readNumber(price, "marketCap") ?? readNumber(detail, "marketCap"),
      },
      valuation: {
        trailingPe: readNumber(detail, "trailingPE"),
        forwardPe: readNumber(detail, "forwardPE") ?? readNumber(stats, "forwardPE"),
        pegRatio: readNumber(stats, "pegRatio"),
        priceToBook: readNumber(stats, "priceToBook"),
        priceToSales:
          readNumber(detail, "priceToSalesTrailing12Months") ??
          readNumber(stats, "priceToSalesTrailing12Months"),
        enterpriseValue: readNumber(stats, "enterpriseValue"),
        enterpriseToRevenue: readNumber(stats, "enterpriseToRevenue"),
        enterpriseToEbitda: readNumber(stats, "enterpriseToEbitda"),
        trailingEps: readNumber(stats, "trailingEps"),
        forwardEps: readNumber(stats, "forwardEps"),
        bookValue: readNumber(stats, "bookValue"),
        dividendYield: readNumber(detail, "dividendYield"),
        dividendRate: readNumber(detail, "dividendRate"),
        payoutRatio: readNumber(detail, "payoutRatio"),
        beta: readNumber(detail, "beta") ?? readNumber(stats, "beta"),
      },
      profitability: {
        grossMargin: readNumber(financials, "grossMargins"),
        operatingMargin: readNumber(financials, "operatingMargins"),
        ebitdaMargin: readNumber(financials, "ebitdaMargins"),
        profitMargin:
          readNumber(financials, "profitMargins") ?? readNumber(stats, "profitMargins"),
        returnOnEquity: readNumber(financials, "returnOnEquity"),
        returnOnAssets: readNumber(financials, "returnOnAssets"),
      },
      growth: {
        revenueGrowth: readNumber(financials, "revenueGrowth"),
        earningsGrowth: readNumber(financials, "earningsGrowth"),
        earningsQuarterlyGrowth: readNumber(stats, "earningsQuarterlyGrowth"),
      },
      health: {
        totalRevenue: readNumber(financials, "totalRevenue"),
        ebitda: readNumber(financials, "ebitda"),
        netIncome: readNumber(stats, "netIncomeToCommon"),
        totalCash: readNumber(financials, "totalCash"),
        totalDebt: readNumber(financials, "totalDebt"),
        debtToEquity: readNumber(financials, "debtToEquity"),
        currentRatio: readNumber(financials, "currentRatio"),
        quickRatio: readNumber(financials, "quickRatio"),
        // quoteSummary's financialData module frequently reports these two as
        // null for NSE-listed companies even though the filings have them —
        // fall back to the timeseries endpoint's own trailing series (see
        // fetchAnnualSeries), discarding it if it is itself stale. The annual
        // series carried below is the next fallback the AI prompt and the
        // Fundamentals tab can both still draw on when even that fails.
        freeCashflow:
          readNumber(financials, "freeCashflow") ??
          usableTrailingCashflow(timeseries.trailingFreeCashflow),
        operatingCashflow:
          readNumber(financials, "operatingCashflow") ??
          usableTrailingCashflow(timeseries.trailingOperatingCashflow),
        sharesOutstanding: readNumber(stats, "sharesOutstanding"),
      },
      annual,
    };
  }

  /**
   * quoteSummary, with one retry on 401. The cookie/crumb pair is cached for
   * an hour, and Yahoo can rotate it inside that window — a stale pair fails
   * every call until the TTL expires, so a 401 drops the cached session and
   * the request is made once more against a fresh one. A second 401 is a real
   * rejection (blocked or rate-limited) and is reported as such.
   */
  private async fetchQuoteSummary(
    instrumentKey: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await getCrumbSession();
      const url =
        `${YAHOO_QUOTE_SUMMARY_URL}/${encodeURIComponent(instrumentKey)}` +
        `?modules=${QUOTE_SUMMARY_MODULES.join(",")}&crumb=${encodeURIComponent(session.crumb)}`;

      const response = await fetchYahoo(url, instrumentKey, session.cookie);

      if (response.status === 401 || response.status === 403) {
        invalidateCrumbSession();
        if (attempt === 0) continue;
        throw new MarketDataError(
          "auth",
          "Yahoo Finance rejected the fundamentals request (blocked/rate-limited)",
        );
      }
      if (response.status === 404) {
        throw new MarketDataError(
          "not_found",
          `Yahoo Finance has no fundamentals for symbol ${instrumentKey}`,
        );
      }
      if (!response.ok) {
        throw new MarketDataError(
          "provider_error",
          `Yahoo Finance returned HTTP ${response.status} for fundamentals`,
        );
      }

      const validation = YahooQuoteSummaryResponseSchema.safeParse(
        await readYahooJson(response, instrumentKey),
      );
      if (!validation.success) {
        logger.error("yahoo finance quoteSummary response failed validation", {
          instrumentKey,
          issues: validation.error.issues.map((i) => i.path.join(".")).join(", "),
        });
        throw new MarketDataError(
          "provider_error",
          "Yahoo Finance response did not match the expected fundamentals schema",
        );
      }

      const { result, error } = validation.data.quoteSummary;
      if (error) {
        throw new MarketDataError(
          "not_found",
          `Yahoo Finance error for symbol ${instrumentKey}: ${error.description}`,
        );
      }
      const modules = result?.[0];
      if (!modules) {
        throw new MarketDataError(
          "not_found",
          `Yahoo Finance returned no fundamentals for symbol ${instrumentKey}`,
        );
      }
      return modules;
    }

    // Unreachable: the loop either returns or throws on both attempts.
    throw new MarketDataError("provider_error", "Yahoo Finance fundamentals request failed");
  }

  /**
   * The annual series plus the TTM cash-flow fallback, in one call — both
   * come from the same fundamentals-timeseries endpoint, so there is no
   * reason to pay for it twice. Each requested type comes back as its own
   * result with its own list of periods, and a company can have reported one
   * but not another for a given year, so the union of the dates is walked
   * rather than any single series' own list.
   */
  private async fetchAnnualSeries(instrumentKey: string): Promise<{
    annual: FundamentalsAnnualPeriod[];
    trailingOperatingCashflow: TrailingCashflowPoint;
    trailingFreeCashflow: TrailingCashflowPoint;
  }> {
    const encoded = encodeURIComponent(instrumentKey);
    const allTypes = [...ANNUAL_TIMESERIES_TYPES, ...TRAILING_CASHFLOW_TYPES];
    const url =
      `${YAHOO_TIMESERIES_URL}/${encoded}?symbol=${encoded}` +
      `&type=${allTypes.join(",")}` +
      `&period1=${TIMESERIES_PERIOD1}&period2=${TIMESERIES_PERIOD2}`;

    const response = await fetchYahoo(url, instrumentKey);
    if (!response.ok) {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance returned HTTP ${response.status} for annual fundamentals`,
      );
    }

    const validation = YahooTimeseriesResponseSchema.safeParse(
      await readYahooJson(response, instrumentKey),
    );
    if (!validation.success) {
      throw new MarketDataError(
        "provider_error",
        "Yahoo Finance response did not match the expected timeseries schema",
      );
    }

    const byType = new Map<AnnualTimeseriesType, Map<string, number>>();
    const byTrailingType = new Map<TrailingCashflowType, Map<string, number>>();
    for (const result of validation.data.timeseries.result ?? []) {
      const type = result.meta.type[0];
      if (type === undefined) continue;
      if ((ANNUAL_TIMESERIES_TYPES as readonly string[]).includes(type)) {
        byType.set(type as AnnualTimeseriesType, readTimeseriesPoints(result));
      } else if ((TRAILING_CASHFLOW_TYPES as readonly string[]).includes(type)) {
        byTrailingType.set(type as TrailingCashflowType, readTimeseriesPoints(result));
      }
    }

    const latestPoint = (points: Map<string, number> | undefined): TrailingCashflowPoint => {
      if (!points || points.size === 0) return null;
      const asOfDate = [...points.keys()].sort((a, b) => b.localeCompare(a))[0];
      return { value: points.get(asOfDate) as number, asOfDate };
    };

    const dates = new Set<string>();
    for (const points of byType.values()) {
      for (const date of points.keys()) dates.add(date);
    }

    const annual: FundamentalsAnnualPeriod[] = [...dates]
      .sort((a, b) => a.localeCompare(b))
      .map((asOfDate) => ({
        asOfDate,
        revenue: byType.get("annualTotalRevenue")?.get(asOfDate) ?? null,
        operatingIncome: byType.get("annualOperatingIncome")?.get(asOfDate) ?? null,
        netIncome: byType.get("annualNetIncomeCommonStockholders")?.get(asOfDate) ?? null,
        dilutedEps: byType.get("annualDilutedEPS")?.get(asOfDate) ?? null,
        operatingCashflow: byType.get("annualOperatingCashFlow")?.get(asOfDate) ?? null,
        freeCashflow: byType.get("annualFreeCashFlow")?.get(asOfDate) ?? null,
      }));

    return {
      annual,
      trailingOperatingCashflow: latestPoint(byTrailingType.get("trailingOperatingCashFlow")),
      trailingFreeCashflow: latestPoint(byTrailingType.get("trailingFreeCashFlow")),
    };
  }
}
