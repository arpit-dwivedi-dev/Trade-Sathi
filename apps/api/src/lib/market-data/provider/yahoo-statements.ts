import { z } from "zod";
import type { ReportingBasis } from "@chartanalyzer/shared";
import { logger } from "../../logger.js";
import { MarketDataError } from "../types.js";
import type {
  RawForwardEstimate,
  RawPeriod,
  RawSpot,
  RawStatements,
} from "../statements.js";
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

/**
 * RAW financial statements out of Yahoo — and nothing else.
 *
 * This module is the provider adapter for the derivation pipeline. It reads
 * reported statement lines only. It deliberately does NOT read
 * revenueGrowth, earningsGrowth, operatingMargins, profitMargins,
 * freeCashflow, pegRatio, payoutRatio, forwardPE or returnOnEquity — those
 * are the pre-computed convenience fields whose mixed-period, mixed-basis
 * values broke the reports this rebuild exists to fix.
 *
 * TWO ENDPOINTS, BECAUSE NEITHER IS ENOUGH ALONE
 *
 * - fundamentals-timeseries carries the rich statement lines (operating
 *   income, pretax income, cash flow, balance sheet) but returns only about
 *   five quarters, can omit a quarter outright, and lags the newest one.
 * - quoteSummary's quarterly history modules carry only revenue and net
 *   income, but reach one quarter more recent and fill the timeseries' gaps.
 *
 * Measured against the live endpoints: for TCS the timeseries skips
 * 2025-09-30 entirely, and for NVDA the timeseries stops at 2026-04-30 while
 * quoteSummary already has 2026-07-31. Merging the two, plus the
 * reconstruction below, is what makes a correct trailing-twelve-month window
 * possible at all.
 *
 * HOW MANY QUARTERS YOU ACTUALLY GET
 *
 * Yahoo caps quarterly history at roughly five periods regardless of the
 * requested window (verified by sweeping period1 from 2014 to 2025 — the
 * window only ever shrinks from the near end, it never extends further
 * back). Merging both endpoints and reconstructing one gap typically yields
 * six or seven quarters, not eight. That is a real ceiling, not a bug here:
 * metrics needing a prior-year TTM comparison are marked 'missing' by the
 * derivation layer rather than filled from a provider-derived field.
 */

// ---------------------------------------------------------------------------
// Timeseries types
// ---------------------------------------------------------------------------

/**
 * The quarterly statement lines. Every one of these is a REPORTED line item.
 *
 * `quarterlyOperatingRevenue` is requested alongside `quarterlyTotalRevenue`
 * because for an Ind AS filer the former is "revenue from operations" — the
 * line that must drive growth and margins — while a filer's total income
 * folds in other income. Where Yahoo reports both and they differ, the
 * operating line wins.
 */
const QUARTERLY_TYPES = [
  "quarterlyTotalRevenue",
  "quarterlyOperatingRevenue",
  "quarterlyCostOfRevenue",
  "quarterlyGrossProfit",
  "quarterlyOperatingIncome",
  "quarterlyPretaxIncome",
  "quarterlyNetIncomeCommonStockholders",
  "quarterlyDilutedAverageShares",
  "quarterlyOperatingCashFlow",
  "quarterlyCapitalExpenditure",
  "quarterlyCashDividendsPaid",
  "quarterlyStockholdersEquity",
  "quarterlyTotalDebt",
  "quarterlyCashCashEquivalentsAndShortTermInvestments",
  "quarterlyOrdinarySharesNumber",
] as const;

const ANNUAL_TYPES = [
  "annualTotalRevenue",
  "annualOperatingRevenue",
  "annualCostOfRevenue",
  "annualGrossProfit",
  "annualOperatingIncome",
  "annualPretaxIncome",
  "annualNetIncomeCommonStockholders",
  "annualDilutedAverageShares",
  "annualOperatingCashFlow",
  "annualCapitalExpenditure",
  "annualCashDividendsPaid",
  "annualStockholdersEquity",
  "annualTotalDebt",
  "annualCashCashEquivalentsAndShortTermInvestments",
  "annualOrdinarySharesNumber",
] as const;

const YahooTimeseriesResponseSchema = z.object({
  timeseries: z.object({
    result: z
      .array(z.object({ meta: z.object({ type: z.array(z.string()) }) }).catchall(z.unknown()))
      .nullable(),
    error: z.unknown().nullable(),
  }),
});

/** One `{ asOfDate, reportedValue: { raw } }` row of a timeseries result. */
function readSeries(
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

/** Cash outflows arrive negative; every consumer wants a magnitude. */
function magnitude(value: number | null): number | null {
  return value === null ? null : Math.abs(value);
}

type SeriesMap = Map<string, Map<string, number>>;

async function fetchTimeseries(
  instrumentKey: string,
  types: readonly string[],
): Promise<SeriesMap> {
  const encoded = encodeURIComponent(instrumentKey);
  const url =
    `${YAHOO_TIMESERIES_URL}/${encoded}?symbol=${encoded}` +
    `&type=${types.join(",")}` +
    `&period1=${TIMESERIES_PERIOD1}&period2=${TIMESERIES_PERIOD2}`;

  const response = await fetchYahoo(url, instrumentKey);
  if (!response.ok) {
    throw new MarketDataError(
      "provider_error",
      `Yahoo Finance returned HTTP ${response.status} for statement timeseries`,
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

  const byType: SeriesMap = new Map();
  for (const result of validation.data.timeseries.result ?? []) {
    const type = result.meta.type[0];
    if (type === undefined) continue;
    byType.set(type, readSeries(result));
  }
  return byType;
}

/**
 * Assembles one RawPeriod from the series maps. `prefix` is "quarterly" or
 * "annual" so a single shape serves both.
 */
function buildPeriod(
  series: SeriesMap,
  prefix: "quarterly" | "annual",
  periodEnd: string,
  months: 3 | 12,
  currency: string | null,
  basis: ReportingBasis,
): RawPeriod {
  const at = (type: string): number | null =>
    series.get(`${prefix}${type}`)?.get(periodEnd) ?? null;

  // Ind AS filers report "revenue from operations" as the operating revenue
  // line. Where both are present they usually agree; where they diverge, the
  // operating line is the one growth and margins must be built on.
  const operatingRevenue = at("OperatingRevenue");
  const totalRevenue = at("TotalRevenue");
  const revenue = operatingRevenue ?? totalRevenue;
  const totalIncome = totalRevenue;
  const otherIncome =
    totalIncome !== null && revenue !== null && totalIncome !== revenue
      ? totalIncome - revenue
      : null;

  return {
    periodEnd,
    months,
    basis,
    currency,
    revenue,
    totalIncome,
    otherIncome,
    costOfRevenue: at("CostOfRevenue"),
    grossProfit: at("GrossProfit"),
    operatingIncome: at("OperatingIncome"),
    pretaxIncome: at("PretaxIncome"),
    netIncome: at("NetIncomeCommonStockholders"),
    dilutedShares: at("DilutedAverageShares"),
    operatingCashFlow: at("OperatingCashFlow"),
    capex: magnitude(at("CapitalExpenditure")),
    dividendsPaid: magnitude(at("CashDividendsPaid")),
    equity: at("StockholdersEquity"),
    totalDebt: at("TotalDebt"),
    cash: at("CashCashEquivalentsAndShortTermInvestments"),
    sharesOutstanding: at("OrdinarySharesNumber"),
  };
}

/** Every period end present in any series under one prefix. */
function periodEnds(series: SeriesMap, prefix: "quarterly" | "annual"): string[] {
  const dates = new Set<string>();
  for (const [type, points] of series) {
    if (!type.startsWith(prefix)) continue;
    for (const date of points.keys()) dates.add(date);
  }
  return [...dates].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// quoteSummary
// ---------------------------------------------------------------------------

const QUOTE_SUMMARY_MODULES = [
  "price",
  "summaryDetail",
  "defaultKeyStatistics",
  "incomeStatementHistoryQuarterly",
  "earningsTrend",
] as const;

const YahooQuoteSummaryResponseSchema = z.object({
  quoteSummary: z.object({
    result: z.array(z.record(z.string(), z.unknown())).nullable(),
    error: z.object({ code: z.string(), description: z.string() }).nullable(),
  }),
});

type Modules = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** quoteSummary, with one retry on 401 — the crumb can rotate inside its TTL. */
async function fetchQuoteSummary(instrumentKey: string): Promise<Modules> {
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
        "Yahoo Finance rejected the statements request (blocked/rate-limited)",
      );
    }
    if (response.status === 404) {
      throw new MarketDataError(
        "not_found",
        `Yahoo Finance has no statements for symbol ${instrumentKey}`,
      );
    }
    if (!response.ok) {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance returned HTTP ${response.status} for statements`,
      );
    }

    const validation = YahooQuoteSummaryResponseSchema.safeParse(
      await readYahooJson(response, instrumentKey),
    );
    if (!validation.success) {
      throw new MarketDataError(
        "provider_error",
        "Yahoo Finance response did not match the expected quoteSummary schema",
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
        `Yahoo Finance returned no statements for symbol ${instrumentKey}`,
      );
    }
    return modules;
  }
  throw new MarketDataError("provider_error", "Yahoo Finance statements request failed");
}

/**
 * The revenue and net income rows out of quoteSummary's quarterly income
 * history. Only those two: the module's other fields (operating income,
 * pretax income, gross profit) come back undefined or zero for both the
 * Indian and US symbols this was verified against, and a zero that means
 * "not reported" is more dangerous than an absent value.
 */
function readQuarterlyIncomeHistory(
  modules: Modules,
): Map<string, { revenue: number | null; netIncome: number | null }> {
  const out = new Map<string, { revenue: number | null; netIncome: number | null }>();
  const module = asRecord(modules["incomeStatementHistoryQuarterly"]);
  const history = module?.["incomeStatementHistory"];
  if (!Array.isArray(history)) return out;

  for (const entry of history) {
    const row = asRecord(entry);
    if (!row) continue;
    const endDate = asRecord(row["endDate"]);
    const fmt = endDate?.["fmt"];
    if (typeof fmt !== "string") continue;
    const revenue = readNumber(row, "totalRevenue");
    const netIncome = readNumber(row, "netIncome");
    if (revenue === null && netIncome === null) continue;
    out.set(fmt, { revenue, netIncome });
  }
  return out;
}

/**
 * Forward consensus EPS WITH the fiscal period it applies to.
 *
 * defaultKeyStatistics.forwardEps carries no period at all, and against the
 * live endpoint it turns out to be the "+1y" estimate — two fiscal years
 * out, not one (TCS: 162.50 for the year ending 2028-03-31; NVDA: 15.46 for
 * the year ending 2028-01-31). Publishing that as a bare "forward P/E" is
 * exactly the unlabelled-period defect this rebuild removes, so the estimate
 * is only ever taken from earningsTrend, where the end date is stated.
 */
function readForwardEstimates(modules: Modules): RawForwardEstimate[] {
  const module = asRecord(modules["earningsTrend"]);
  const trend = module?.["trend"];
  if (!Array.isArray(trend)) return [];

  const out: RawForwardEstimate[] = [];
  for (const entry of trend) {
    const row = asRecord(entry);
    if (!row) continue;
    const period = row["period"];
    if (period !== "0y" && period !== "+1y") continue;
    const endDate = row["endDate"];
    const estimate = asRecord(row["earningsEstimate"]);
    out.push({
      epsAvg: readNumber(estimate, "avg"),
      periodEnd: typeof endDate === "string" ? endDate.slice(0, 10) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gap reconstruction
// ---------------------------------------------------------------------------

const RECONSTRUCTABLE_LINES = [
  "revenue",
  "totalIncome",
  "costOfRevenue",
  "grossProfit",
  "operatingIncome",
  "pretaxIncome",
  "netIncome",
  "operatingCashFlow",
  "capex",
  "dividendsPaid",
] as const;

/** An empty quarter, ready to be filled in. */
function blankQuarter(periodEnd: string, template: RawPeriod): RawPeriod {
  return {
    periodEnd,
    months: 3,
    basis: template.basis,
    currency: template.currency,
    revenue: null,
    totalIncome: null,
    otherIncome: null,
    costOfRevenue: null,
    grossProfit: null,
    operatingIncome: null,
    pretaxIncome: null,
    netIncome: null,
    dilutedShares: null,
    operatingCashFlow: null,
    capex: null,
    dividendsPaid: null,
    equity: null,
    totalDebt: null,
    cash: null,
    sharesOutstanding: null,
    reconstructed: true,
  };
}

/**
 * Fills a missing quarterly FLOW figure as (fiscal year − the other three
 * quarters of that year).
 *
 * Applied PER LINE, not per period. Yahoo's coverage is ragged within a
 * quarter as well as across quarters: TCS's 2025-09-30 arrives from
 * quoteSummary carrying revenue and net income but no operating income, no
 * cash flow and no dividend line, so a whole-period test would see the
 * quarter as present and leave four trailing metrics unresolvable. Per line,
 * the same fiscal year reconstructs each of those from the audited annual
 * figure.
 *
 * Only ever applied where exactly one quarter of a fiscal year lacks the
 * line — with two unknowns the system is underdetermined and nothing is
 * inferred.
 *
 * Flow lines only. A balance-sheet figure is a point-in-time stock and does
 * not sum across a year, so equity, debt, cash and share counts are never
 * reconstructed this way.
 *
 * Validated against the live endpoint: TCS's 2025-09-30 quarter reconstructs
 * to 657,990,000,000 of revenue and 120,750,000,000 of net income, which is
 * exactly what Yahoo's own quoteSummary reports for that quarter.
 */
function reconstructMissingQuarters(
  quarters: RawPeriod[],
  annual: RawPeriod[],
): RawPeriod[] {
  if (annual.length === 0) return quarters;

  const byEnd = new Map(quarters.map((q) => [q.periodEnd, q]));

  for (const year of annual) {
    const ends = quarterEndsOfFiscalYear(year.periodEnd);

    for (const line of RECONSTRUCTABLE_LINES) {
      const annualValue = year[line];
      if (annualValue === null) continue;

      const present: number[] = [];
      const absent: string[] = [];
      for (const end of ends) {
        const value = byEnd.get(end)?.[line] ?? null;
        if (value === null) absent.push(end);
        else present.push(value);
      }
      if (absent.length !== 1 || present.length !== 3) continue;

      const periodEnd = absent[0];
      const quarter = byEnd.get(periodEnd) ?? blankQuarter(periodEnd, year);
      quarter[line] = annualValue - present.reduce((sum, v) => sum + v, 0);
      byEnd.set(periodEnd, quarter);
    }
  }

  // Keep the derived other-income line consistent with whatever was filled.
  for (const quarter of byEnd.values()) {
    if (quarter.revenue !== null && quarter.totalIncome !== null) {
      quarter.otherIncome =
        quarter.totalIncome === quarter.revenue ? null : quarter.totalIncome - quarter.revenue;
    }
  }

  return [...byEnd.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/**
 * The four quarter-end dates of the fiscal year ending on `yearEnd`.
 *
 * Months are stepped from the FIRST of the month, never from the year-end
 * day. Stepping back three months from "2026-03-31" lands on 31 June, which
 * does not exist and silently rolls forward into July — every reconstructed
 * quarter would then be matched against the wrong period.
 */
function quarterEndsOfFiscalYear(yearEnd: string): string[] {
  const year = Number(yearEnd.slice(0, 4));
  const month = Number(yearEnd.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return [];

  const ends: string[] = [];
  for (let back = 3; back >= 0; back--) {
    // Day 0 of the following month is the last day of the month wanted.
    const lastDay = new Date(Date.UTC(year, month - back * 3, 0));
    ends.push(lastDay.toISOString().slice(0, 10));
  }
  return ends;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Every raw statement this pipeline can obtain for one Yahoo ticker.
 *
 * The two upstream calls run together. quoteSummary is required (it carries
 * the spot price and the most recent quarter); the timeseries is the richer
 * of the two but is allowed to fail on its own, leaving a thinner set of
 * periods rather than failing the whole read.
 */
export async function getRawStatements(instrumentKey: string): Promise<RawStatements> {
  const [modules, quarterlySeries, annualSeries] = await Promise.all([
    fetchQuoteSummary(instrumentKey),
    fetchTimeseries(instrumentKey, QUARTERLY_TYPES).catch((cause: unknown) => {
      logger.warn("yahoo quarterly statement timeseries unavailable", {
        instrumentKey,
        cause: String(cause),
      });
      return new Map() as SeriesMap;
    }),
    fetchTimeseries(instrumentKey, ANNUAL_TYPES).catch((cause: unknown) => {
      logger.warn("yahoo annual statement timeseries unavailable", {
        instrumentKey,
        cause: String(cause),
      });
      return new Map() as SeriesMap;
    }),
  ]);

  const price = asRecord(modules["price"]);
  const detail = asRecord(modules["summaryDetail"]);
  const stats = asRecord(modules["defaultKeyStatistics"]);

  const financialCurrency =
    readString(price, "financialCurrency") ?? readString(price, "currency");

  const spot: RawSpot = {
    price: readNumber(price, "regularMarketPrice"),
    asOf: readEpochSeconds(price, "regularMarketTime"),
    marketCap: readNumber(price, "marketCap"),
    currency: readString(price, "currency"),
    financialCurrency,
    dividendDeclaredPerShare: readNumber(detail, "dividendRate"),
    dividendYield: readNumber(detail, "dividendYield"),
    mostRecentQuarter: readEpochSeconds(stats, "mostRecentQuarter")?.slice(0, 10) ?? null,
  };

  // Yahoo does not state the accounting basis anywhere in these responses.
  // It is NOT assumed to be consolidated: an unknown basis is recorded as
  // unknown, and the derivation layer decides what an unknown basis is
  // allowed to support. Guessing here is precisely how a standalone quarter
  // would end up silently summed into a consolidated TTM.
  const basis: ReportingBasis = "unknown";

  const annual: RawPeriod[] = periodEnds(annualSeries, "annual").map((end) =>
    buildPeriod(annualSeries, "annual", end, 12, financialCurrency, basis),
  );

  const quarters: RawPeriod[] = periodEnds(quarterlySeries, "quarterly").map((end) =>
    buildPeriod(quarterlySeries, "quarterly", end, 3, financialCurrency, basis),
  );

  // quoteSummary's quarterly income history reaches one period further
  // forward than the timeseries and fills its gaps. It only carries revenue
  // and net income, so it enriches an existing quarter rather than replacing
  // it, and creates a new one only where the timeseries had none at all.
  const byEnd = new Map(quarters.map((q) => [q.periodEnd, q]));
  for (const [periodEnd, row] of readQuarterlyIncomeHistory(modules)) {
    const existing = byEnd.get(periodEnd);
    if (existing) {
      existing.revenue ??= row.revenue;
      existing.totalIncome ??= row.revenue;
      existing.netIncome ??= row.netIncome;
      continue;
    }
    byEnd.set(periodEnd, {
      periodEnd,
      months: 3,
      basis,
      currency: financialCurrency,
      revenue: row.revenue,
      totalIncome: row.revenue,
      otherIncome: null,
      costOfRevenue: null,
      grossProfit: null,
      operatingIncome: null,
      pretaxIncome: null,
      netIncome: row.netIncome,
      dilutedShares: null,
      operatingCashFlow: null,
      capex: null,
      dividendsPaid: null,
      equity: null,
      totalDebt: null,
      cash: null,
      sharesOutstanding: null,
    });
  }

  const merged = reconstructMissingQuarters(
    [...byEnd.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)),
    annual,
  );

  return {
    quarterly: merged,
    annual,
    spot,
    forward: readForwardEstimates(modules),
    // No corporate-action feed is wired up. Null rather than [] on purpose:
    // the share-count plausibility rule must not read "no feed" as "no bonus
    // issue happened" and clear a company whose share count legitimately
    // doubled. See the corporate-actions rule in the plausibility gate.
    corporateActions: null,
  };
}

/** The fiscal-year-end month read from the filings, or null when unknown. */
export function fiscalYearEndMonthFromStatements(statements: RawStatements): number | null {
  const latest = statements.annual[statements.annual.length - 1];
  if (!latest) return null;
  const month = Number(latest.periodEnd.slice(5, 7));
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : null;
}
