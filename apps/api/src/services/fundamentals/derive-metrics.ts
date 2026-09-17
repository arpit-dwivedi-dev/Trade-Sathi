import type {
  DerivedMetrics,
  Metric,
  ReportingBasis,
  ReportingProfile,
} from "@tradesathi/shared";
import type { RawPeriod, RawStatements } from "../../lib/market-data/statements.js";
import { formatFiscalYearLabel } from "./reporting-profile.js";

/**
 * Derives every ratio the fundamentals report reasons about, from
 * period-stamped RAW statements only.
 *
 * NO NETWORK. NO PROVIDER-DERIVED FIELDS. Every output carries the period it
 * belongs to, the basis it was filed under, and what it was computed from.
 *
 * The rule this module exists to enforce: a metric without a period is a bug.
 * The reports that motivated the rebuild were not wrong because the numbers
 * were wrong — the raw statements matched the filings exactly — but because a
 * quarterly value was labelled TTM, and a cash-flow field that subtracted
 * acquisitions was labelled free cash flow.
 */

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

/** The statement lines a trailing window can be summed over. */
type FlowLine =
  | "revenue"
  | "totalIncome"
  | "otherIncome"
  | "costOfRevenue"
  | "grossProfit"
  | "operatingIncome"
  | "pretaxIncome"
  | "netIncome"
  | "operatingCashFlow"
  | "capex"
  | "dividendsPaid";

/** Balance-sheet lines, which are point-in-time stocks and never summed. */
type StockLine = "equity" | "totalDebt" | "cash" | "sharesOutstanding" | "dilutedShares";

/**
 * How far apart two consecutive quarter ends may be.
 *
 * The ceiling is set by the 16-week fiscal quarter, not the 13-week one.
 * Costco's fiscal year runs 12/12/12/16 weeks, so the gap into its fourth
 * quarter is 112 days — outside a 100-day ceiling, which silently declared
 * the company's own consecutive quarters non-contiguous and left every
 * trailing comparison unreportable. Retail and food-service filers on 52/53
 * week calendars do this routinely.
 *
 * Still nowhere near ambiguous: a genuinely SKIPPED quarter puts two ends at
 * least 168 days apart, so the band cannot mistake a gap in coverage for a
 * long quarter.
 */
const MIN_QUARTER_GAP_DAYS = 80;
const MAX_QUARTER_GAP_DAYS = 120;

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}

/**
 * True when two quarter ends are one quarter apart.
 *
 * Contiguity is checked, not assumed. A provider that silently omits a
 * quarter (Yahoo drops TCS's 2025-09-30 from its timeseries) would otherwise
 * hand back four rows spanning fifteen months and they would be summed into
 * something labelled "trailing twelve months".
 */
function isContiguous(earlier: RawPeriod, later: RawPeriod): boolean {
  const gap = daysBetween(earlier.periodEnd, later.periodEnd);
  return gap >= MIN_QUARTER_GAP_DAYS && gap <= MAX_QUARTER_GAP_DAYS;
}

interface Window {
  quarters: RawPeriod[];
  basis: ReportingBasis;
  /** True when the four quarters do not share one reporting basis. */
  mixedBasis: boolean;
}

/**
 * The most recent run of four contiguous quarters in which every named line
 * is reported.
 *
 * Per-line rather than one window for the whole payload, because
 * availability is genuinely ragged: for TCS the income statement reaches
 * 2026-06-30 while the cash-flow statement stops at 2026-03-31. Forcing one
 * shared window would either discard the newest income data or invent
 * cash-flow data. Two windows, each correctly labelled, is the honest
 * answer — and it is why `period` is per-metric rather than per-report.
 *
 * `offset` selects an older window: 0 is the latest, 1 is the one ending
 * four quarters earlier (the prior-year comparison).
 */
function findWindow(
  quarters: RawPeriod[],
  lines: (FlowLine | StockLine)[],
  offset = 0,
): Window | null {
  const usable = quarters.filter((q) => lines.every((line) => q[line] !== null));
  // Walk newest-first, taking runs of four contiguous quarters.
  for (let end = usable.length - 1; end >= 3; end--) {
    const run = usable.slice(end - 3, end + 1);
    let contiguous = true;
    for (let i = 1; i < run.length; i++) {
      if (!isContiguous(run[i - 1], run[i])) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;

    if (offset > 0) {
      // The prior window must abut this one — the quarter immediately before
      // its earliest member, not merely "four rows further down the array".
      const earlierEnd = end - 4;
      if (earlierEnd < 3) return null;
      const priorRun = usable.slice(earlierEnd - 3, earlierEnd + 1);
      if (priorRun.length < 4) return null;
      if (!isContiguous(priorRun[3], run[0])) return null;
      for (let i = 1; i < priorRun.length; i++) {
        if (!isContiguous(priorRun[i - 1], priorRun[i])) return null;
      }
      return windowOf(priorRun);
    }
    return windowOf(run);
  }
  return null;
}

function windowOf(quarters: RawPeriod[]): Window {
  const bases = new Set(quarters.map((q) => q.basis));
  return {
    quarters,
    basis: bases.size === 1 ? quarters[0].basis : "unknown",
    mixedBasis: bases.size > 1,
  };
}

function sum(window: Window, line: FlowLine): number {
  return window.quarters.reduce((total, q) => total + (q[line] as number), 0);
}

/** "TTM 2025-07-27..2026-07-26" — the window's actual span, both ends. */
function ttmLabel(window: Window): string {
  const last = window.quarters[window.quarters.length - 1].periodEnd;
  const firstEnd = window.quarters[0].periodEnd;
  const start = new Date(`${firstEnd}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - 3);
  start.setUTCDate(start.getUTCDate() + 1);
  return `TTM ${start.toISOString().slice(0, 10)}..${last}`;
}

/**
 * One twelve-month figure and where it came from: a quarterly window, or the
 * audited fiscal year that stood in for one. `year` is non-null only in the
 * second case, and exists so a ratio built on this figure can take its other
 * leg from the same span.
 */
interface Trailing {
  metric: Metric;
  window: Window | null;
  year: RawPeriod | null;
}

/** The most recent audited fiscal year reporting every named line. */
function latestFiscalYear(annual: RawPeriod[], lines: FlowLine[]): RawPeriod | null {
  for (let i = annual.length - 1; i >= 0; i--) {
    if (lines.every((line) => annual[i][line] !== null)) return annual[i];
  }
  return null;
}

function derivedFrom(window: Window, lines: string[]): string[] {
  const span = `${window.quarters[0].periodEnd}..${window.quarters[window.quarters.length - 1].periodEnd}`;
  return lines.map((line) => `${line} (4 quarters ${span})`);
}

// ---------------------------------------------------------------------------
// Metric constructors
// ---------------------------------------------------------------------------

function missing(period: string, currency: string, note: string, from: string[] = []): Metric {
  return {
    value: null,
    period,
    basis: "unknown",
    currency,
    derivedFrom: from,
    reliability: "missing",
    note,
  };
}

function ok(
  value: number,
  period: string,
  basis: ReportingBasis,
  currency: string,
  from: string[],
  extra: Partial<Metric> = {},
): Metric {
  return {
    value,
    period,
    basis,
    currency,
    derivedFrom: from,
    reliability: "ok",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DeriveMetricsInput {
  statements: RawStatements;
  profile: ReportingProfile;
}

export function deriveMetrics(input: DeriveMetricsInput): DerivedMetrics {
  const { statements, profile } = input;
  const { quarterly, annual, spot } = statements;
  const cur = profile.reportingCurrency;
  const marketCur = spot.currency ?? cur;

  // Basis pinning, highest priority. Indian filers publish consolidated AND
  // standalone every quarter; summing across the two produces a number that
  // corresponds to no filing at all. A window whose quarters disagree is
  // never summed — it is reported missing.
  const mixedBasisNote =
    "mixed reporting basis across the trailing window; consolidated and standalone figures are never summed together";

  /** Builds a summed TTM metric for one line, or a missing one. */
  const ttmSum = (line: FlowLine, label: string): { metric: Metric; window: Window | null } => {
    const window = findWindow(quarterly, [line]);
    if (!window) {
      return {
        metric: missing(
          "TTM unavailable",
          cur,
          `fewer than four contiguous quarters report ${label}`,
        ),
        window: null,
      };
    }
    if (window.mixedBasis) {
      return { metric: missing(ttmLabel(window), cur, mixedBasisNote), window: null };
    }
    return {
      metric: ok(sum(window, line), ttmLabel(window), window.basis, cur, derivedFrom(window, [label])),
      window,
    };
  };

  /**
   * A twelve-month figure for a CASH-FLOW line, from four contiguous quarters
   * where they exist and from the audited fiscal year where they cannot.
   *
   * India files no quarterly cash flow. SEBI requires the statement twice a
   * year, so no source — the filings, the vendor, or any combination of them
   * — can produce four contiguous quarters of operating cash flow for an
   * Indian company, and operating cash flow, capex, dividends paid, free cash
   * flow and the cash payout ratio came back missing for every one of them.
   * The audited fiscal year is a genuine twelve-month figure and it is
   * published; the only thing that was missing was a route to it.
   *
   * The span is never disguised. A fiscal-year figure is labelled with its
   * fiscal year, not as TTM, so the two can never be read as the same window
   * — which is the defect this whole layer was rebuilt to remove.
   */
  const trailingCash = (line: FlowLine, label: string): Trailing => {
    const ttm = ttmSum(line, label);
    if (ttm.metric.value !== null) return { ...ttm, year: null };

    const year = latestFiscalYear(annual, [line]);
    if (!year) return { ...ttm, year: null };
    return {
      metric: ok(
        year[line] as number,
        formatFiscalYearLabel(year.periodEnd, profile),
        year.basis,
        cur,
        [`${label} (fiscal year ended ${year.periodEnd})`],
        { note: `audited fiscal year, not a trailing twelve months: ${label} is not filed quarterly` },
      ),
      window: null,
      year,
    };
  };

  const revenueRes = ttmSum("revenue", "revenue");
  const netIncomeRes = ttmSum("netIncome", "net income");
  const grossProfitRes = ttmSum("grossProfit", "gross profit");
  const operatingIncomeRes = ttmSum("operatingIncome", "operating income");
  const pretaxRes = ttmSum("pretaxIncome", "pretax income");
  const ocfRes = trailingCash("operatingCashFlow", "operating cash flow");
  const capexRes = trailingCash("capex", "capital expenditure");
  const dividendsPaidRes = trailingCash("dividendsPaid", "dividends paid");

  // --- Revenue-line integrity -------------------------------------------
  // Ind AS filers report revenue from operations and total income as
  // separate lines. TCS Q1 FY27 is 72,275 cr of revenue against 73,843 cr of
  // total income — a 2.2% gap that silently corrupts growth and every margin
  // if the two are ever mixed. Where all three are reported, the identity is
  // asserted rather than trusted.
  const revenueLineNote = assertRevenueIdentity(quarterly);

  // --- Growth ------------------------------------------------------------
  const fxUnadjusted = cur !== "USD";
  const fxNote = "reported-currency growth; FX effects not isolated";

  const growth = (
    line: FlowLine,
    label: string,
  ): Metric => {
    const current = findWindow(quarterly, [line], 0);
    const prior = findWindow(quarterly, [line], 1);
    if (!current || !prior) {
      return missing(
        "TTM vs prior TTM unavailable",
        cur,
        `a trailing-twelve-month ${label} comparison needs eight contiguous quarters; the filings available reach only ${countContiguous(quarterly, line)}`,
      );
    }
    if (current.mixedBasis || prior.mixedBasis) {
      return missing(ttmLabel(current), cur, mixedBasisNote);
    }
    if (current.basis !== prior.basis) {
      return missing(ttmLabel(current), cur, mixedBasisNote);
    }
    const currentValue = sum(current, line);
    const priorValue = sum(prior, line);
    if (priorValue === 0) {
      return missing(ttmLabel(current), cur, `the prior-period ${label} is zero, so a growth rate is undefined`);
    }
    // A sign change makes the ratio meaningless rather than merely large: a
    // swing from a loss to a profit is not "growth of −340%".
    if (priorValue < 0 !== currentValue < 0) {
      return missing(
        ttmLabel(current),
        cur,
        `${label} changed sign between the two periods, so a percentage growth rate would be misleading`,
      );
    }
    return ok(
      currentValue / priorValue - 1,
      `${ttmLabel(current)} vs ${ttmLabel(prior)}`,
      current.basis,
      cur,
      [...derivedFrom(current, [label]), ...derivedFrom(prior, [label])],
      fxUnadjusted ? { fxUnadjusted: true, note: fxNote } : {},
    );
  };

  const revenueGrowth = growth("revenue", "revenue");
  const earningsGrowth = growth("netIncome", "net income");

  // A USD-denominated revenue figure appears in NO source this pipeline
  // reads, for any filer, in any currency — so a metric for it can never be
  // anything but missing, and was reported as a data gap on every non-USD
  // instrument forever. It is not a gap: nobody files it.
  //
  // The caveat it existed to raise is already carried where it belongs, on
  // the growth figures themselves — revenueGrowth and earningsGrowth are
  // stamped fxUnadjusted with a note for every non-USD filer (see fxNote
  // above), so a reader of TCS's 13.9% rupee growth is told in the same
  // breath that the currency effect is not isolated from it.

  // --- Fiscal-year growth, from the audited annual statements ------------
  // Emitted alongside the trailing figures, never as a substitute for them.
  // The label always spells out the fiscal months, so a reader can never
  // mistake an annual comparison for a trailing one.
  const fyGrowth = (line: FlowLine, label: string): Metric => {
    const years = annual.filter((a) => a[line] !== null);
    if (years.length < 2) {
      return missing(
        "fiscal-year comparison unavailable",
        cur,
        `fewer than two fiscal years report ${label}`,
      );
    }
    const latest = years[years.length - 1];
    const prior = years[years.length - 2];
    const latestValue = latest[line] as number;
    const priorValue = prior[line] as number;
    const period = `${formatFiscalYearLabel(latest.periodEnd, profile)} vs ${formatFiscalYearLabel(prior.periodEnd, profile)}`;

    if (priorValue === 0) {
      return missing(period, cur, `the prior fiscal year's ${label} is zero, so a growth rate is undefined`);
    }
    if (priorValue < 0 !== latestValue < 0) {
      return missing(
        period,
        cur,
        `${label} changed sign between the two fiscal years, so a percentage growth rate would be misleading`,
      );
    }
    if (latest.basis !== prior.basis) {
      return missing(period, cur, mixedBasisNote);
    }
    return ok(
      latestValue / priorValue - 1,
      period,
      latest.basis,
      cur,
      [`${label} (${prior.periodEnd}) and ${label} (${latest.periodEnd})`],
      fxUnadjusted ? { fxUnadjusted: true, note: fxNote } : {},
    );
  };

  const revenueGrowthFy = fyGrowth("revenue", "revenue");
  const earningsGrowthFy = fyGrowth("netIncome", "net income");

  // --- Margins, all on one TTM window per pair --------------------------
  const margin = (numeratorLine: FlowLine, label: string): Metric => {
    const window = findWindow(quarterly, [numeratorLine, "revenue"]);
    if (!window) {
      return missing("TTM unavailable", cur, `fewer than four contiguous quarters report both ${label} and revenue`);
    }
    if (window.mixedBasis) return missing(ttmLabel(window), cur, mixedBasisNote);
    const revenueTotal = sum(window, "revenue");
    if (revenueTotal === 0) {
      return missing(ttmLabel(window), cur, "trailing revenue is zero, so a margin is undefined");
    }
    return ok(
      sum(window, numeratorLine) / revenueTotal,
      ttmLabel(window),
      window.basis,
      cur,
      derivedFrom(window, [label, "revenue"]),
    );
  };

  const grossMargin = margin("grossProfit", "gross profit");
  const operatingMargin = margin("operatingIncome", "operating income");
  const netMargin = margin("netIncome", "net income");

  // --- Free cash flow ----------------------------------------------------
  // FCF = OCF − capex. Nothing else is ever subtracted. The provider's own
  // free-cash-flow field additionally nets off acquisitions and purchases of
  // securities, which is how a fabless company came out with $92B of implied
  // capital expenditure against ~$7B of real capex.
  // Both legs must come from ONE span, so this resolves its own rather than
  // subtracting the capex metric from the cash-flow metric — those two can
  // legitimately land on different windows when coverage is ragged.
  const fcfWindow = findWindow(quarterly, ["operatingCashFlow", "capex"]);
  const fcfYear = fcfWindow ? null : latestFiscalYear(annual, ["operatingCashFlow", "capex"]);
  const fcf = fcfWindow
    ? fcfWindow.mixedBasis
      ? missing(ttmLabel(fcfWindow), cur, mixedBasisNote)
      : ok(
          sum(fcfWindow, "operatingCashFlow") - sum(fcfWindow, "capex"),
          ttmLabel(fcfWindow),
          fcfWindow.basis,
          cur,
          derivedFrom(fcfWindow, ["operating cash flow", "capital expenditure"]),
          { note: "operating cash flow less capital expenditure only" },
        )
    : fcfYear
      ? ok(
          (fcfYear.operatingCashFlow as number) - (fcfYear.capex as number),
          formatFiscalYearLabel(fcfYear.periodEnd, profile),
          fcfYear.basis,
          cur,
          [`operating cash flow and capital expenditure (fiscal year ended ${fcfYear.periodEnd})`],
          {
            note: "operating cash flow less capital expenditure only; audited fiscal year, not a trailing twelve months",
          },
        )
      : missing(
          "TTM unavailable",
          cur,
          "neither four contiguous quarters nor an audited fiscal year reports both operating cash flow and capital expenditure",
        );

  // --- Return on equity --------------------------------------------------
  // Average equity across the four quarters, not the closing balance: the
  // numerator spans a year, so a point-in-time denominator would overstate
  // the return of any company whose equity grew through it. The period label
  // says "average equity" so the reader can see which convention was used.
  const roe = deriveRoe(quarterly, cur, mixedBasisNote);

  // --- Balance sheet, most recent quarter --------------------------------
  const latestWith = (line: StockLine): RawPeriod | null => {
    for (let i = quarterly.length - 1; i >= 0; i--) {
      if (quarterly[i][line] !== null) return quarterly[i];
    }
    return null;
  };

  const stock = (line: StockLine, label: string): Metric => {
    const period = latestWith(line);
    if (!period) return missing("MRQ unavailable", cur, `no reported quarter carries ${label}`);
    return ok(
      period[line] as number,
      `MRQ ${period.periodEnd}`,
      period.basis,
      cur,
      [`${label} (${period.periodEnd})`],
    );
  };

  const totalDebt = stock("totalDebt", "total debt");
  const totalCash = stock("cash", "cash and short-term investments");
  const equity = stock("equity", "shareholders' equity");
  const dilutedShares = stock("dilutedShares", "diluted average shares");

  const netCashPeriod = latestWith("totalDebt");
  const netCash =
    totalDebt.value === null || totalCash.value === null || !netCashPeriod
      ? missing("MRQ unavailable", cur, "net cash needs both total debt and cash from the same quarter")
      : totalCash.value === null
        ? missing("MRQ unavailable", cur, "no reported quarter carries cash")
        : ok(
            totalCash.value - totalDebt.value,
            `MRQ ${netCashPeriod.periodEnd}`,
            netCashPeriod.basis,
            cur,
            [`cash less total debt (${netCashPeriod.periodEnd})`],
          );

  // --- Market and per share ---------------------------------------------
  const price =
    spot.price === null
      ? missing("spot", marketCur, "no price was reported")
      : ok(spot.price, "spot", "unknown", marketCur, [`quoted price as of ${spot.asOf ?? "unknown"}`]);

  const marketCap =
    spot.marketCap === null
      ? missing("spot", marketCur, "no market capitalisation was reported")
      : ok(spot.marketCap, "spot", "unknown", marketCur, ["quoted market capitalisation"]);

  const trailingEps =
    netIncomeRes.metric.value === null || dilutedShares.value === null || dilutedShares.value === 0
      ? missing(
          netIncomeRes.metric.period,
          cur,
          "trailing earnings per share needs both trailing net income and a diluted share count",
        )
      : ok(
          netIncomeRes.metric.value / dilutedShares.value,
          `${netIncomeRes.metric.period}, ${dilutedShares.period} diluted shares`,
          netIncomeRes.metric.basis,
          cur,
          ["trailing net income ÷ diluted shares"],
        );

  // Price and statements can be quoted in different currencies for a
  // cross-listed line; dividing one by the other then produces a number that
  // means nothing. The multiple is withheld rather than qualified.
  const currencyComparable = spot.currency === null || spot.currency === cur;

  const trailingPe =
    !currencyComparable
      ? missing("spot", marketCur, "the quoted price and the financial statements are in different currencies, so a multiple cannot be formed")
      : price.value === null || trailingEps.value === null
        ? missing("spot", marketCur, "a trailing multiple needs both a price and trailing earnings per share")
        : trailingEps.value <= 0
          ? missing(
              `${trailingEps.period}, price ${spot.asOf ?? "spot"}`,
              marketCur,
              "trailing earnings are not positive, so a price/earnings multiple is not meaningful",
            )
          : ok(
              price.value / trailingEps.value,
              `price ${spot.asOf?.slice(0, 10) ?? "spot"} ÷ ${trailingEps.period}`,
              trailingEps.basis,
              marketCur,
              ["price ÷ trailing earnings per share"],
            );

  const forwardPe = deriveForwardPe(statements, profile, price.value, currencyComparable, marketCur);

  // --- Dividends, two bases, both labelled -------------------------------
  // Indian final dividends are declared after the fiscal year closes and paid
  // in the next one, so the cash-paid basis systematically lags the declared
  // basis. A gap between these two is EXPECTED and is never a data conflict —
  // treating it as one is what produced the spurious "unk" downgrade on both
  // TCS and NVDA.
  // A ratio's two legs must span the same period. Where dividends paid came
  // from an audited fiscal year rather than a trailing window, the earnings
  // it is measured against come from THAT year — dividing a fiscal year's
  // dividends by a trailing year's earnings would compare two different
  // twelve-month spans and label the result as one of them.
  const payoutEarnings = dividendsPaidRes.year
    ? { value: dividendsPaidRes.year.netIncome, period: formatFiscalYearLabel(dividendsPaidRes.year.periodEnd, profile) }
    : { value: netIncomeRes.metric.value, period: netIncomeRes.metric.period };

  const payoutRatioCash =
    dividendsPaidRes.metric.value === null || payoutEarnings.value === null
      ? missing(
          dividendsPaidRes.metric.period,
          cur,
          "the cash payout basis needs both dividends paid and net income over the same period",
        )
      : payoutEarnings.value <= 0
        ? missing(payoutEarnings.period, cur, "net income is not positive, so a payout ratio is not meaningful")
        : ok(
            dividendsPaidRes.metric.value / payoutEarnings.value,
            `${dividendsPaidRes.metric.period} dividends paid ÷ ${payoutEarnings.period} net income`,
            dividendsPaidRes.metric.basis,
            cur,
            ["dividends paid ÷ net income over the same period"],
            { note: "cash basis: dividends actually paid in the window" },
          );

  const payoutRatioDeclared =
    spot.dividendDeclaredPerShare === null ||
    dilutedShares.value === null ||
    netIncomeRes.metric.value === null
      ? missing(
          netIncomeRes.metric.period,
          cur,
          "the declared payout basis needs a declared dividend per share, a share count and trailing net income",
        )
      : netIncomeRes.metric.value <= 0
        ? missing(netIncomeRes.metric.period, cur, "trailing net income is not positive, so a payout ratio is not meaningful")
        : ok(
            (spot.dividendDeclaredPerShare * dilutedShares.value) / netIncomeRes.metric.value,
            `declared per share (trailing) × ${dilutedShares.period} shares ÷ ${netIncomeRes.metric.period} net income`,
            netIncomeRes.metric.basis,
            cur,
            ["declared dividend per share × diluted shares ÷ trailing net income"],
            { note: "declared basis: a gap against the cash basis is expected, not a conflict" },
          );

  // --- Diagnostics -------------------------------------------------------
  const taxWindow = findWindow(quarterly, ["netIncome", "pretaxIncome"]);
  const impliedTaxRate = !taxWindow
    ? missing("TTM unavailable", cur, "fewer than four contiguous quarters report both net income and pretax income")
    : (() => {
        const pretax = sum(taxWindow, "pretaxIncome");
        if (pretax === 0) {
          return missing(ttmLabel(taxWindow), cur, "trailing pretax income is zero, so an implied tax rate is undefined");
        }
        return ok(
          1 - sum(taxWindow, "netIncome") / pretax,
          ttmLabel(taxWindow),
          taxWindow.basis,
          cur,
          derivedFrom(taxWindow, ["net income", "pretax income"]),
        );
      })();

  // Q4 lumpiness: where the fourth quarter is published as the balancing
  // figure against the audited year, year-end adjustments concentrate in it.
  // Noted on any trailing window that contains one — and deliberately NOT
  // smoothed, because smoothing would hide the very lumpiness being flagged.
  const q4Note = profile.q4IsBalancingFigure ? q4LumpinessNote(revenueRes.window, profile) : null;

  const metrics: DerivedMetrics = {
    revenue: revenueRes.metric,
    netIncome: netIncomeRes.metric,
    grossProfit: grossProfitRes.metric,
    operatingIncome: operatingIncomeRes.metric,
    pretaxIncome: pretaxRes.metric,
    revenueGrowth,
    earningsGrowth,
    revenueGrowthFy,
    earningsGrowthFy,
    grossMargin,
    operatingMargin,
    netMargin,
    operatingCashFlow: ocfRes.metric,
    dividendsPaid: dividendsPaidRes.metric,
    capex: capexRes.metric,
    fcf,
    roe,
    totalDebt,
    totalCash,
    netCash,
    equity,
    price,
    dilutedShares,
    trailingEps,
    trailingPe,
    forwardPe,
    marketCap,
    payoutRatioCash,
    payoutRatioDeclared,
    impliedTaxRate,
  };

  if (q4Note) appendNote(metrics, ["revenue", "netIncome", "operatingMargin", "netMargin"], q4Note);
  if (revenueLineNote) appendNote(metrics, ["revenue", "revenueGrowth"], revenueLineNote);

  // An unknown basis is stated rather than assumed to be consolidated. This
  // provider does not report which basis a statement was filed under, and a
  // report that silently presumes consolidated for an Ind AS filer is making
  // exactly the assumption this layer refuses to make.
  if (profile.basisAvailable.length > 1) {
    appendNote(
      metrics,
      ["revenue", "netIncome", "operatingMargin", "netMargin", "fcf", "roe"],
      "the filings do not state whether these are consolidated or standalone figures",
    );
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendNote(metrics: DerivedMetrics, keys: (keyof DerivedMetrics)[], note: string): void {
  for (const key of keys) {
    const metric = metrics[key];
    // Not every key is guaranteed to be emitted for every filer.
    if (!metric) continue;
    metric.note = metric.note ? `${metric.note}; ${note}` : note;
  }
}

/** How many contiguous quarters actually report a line, for the note text. */
function countContiguous(quarters: RawPeriod[], line: FlowLine): number {
  const usable = quarters.filter((q) => q[line] !== null);
  let best = usable.length > 0 ? 1 : 0;
  let run = best;
  for (let i = 1; i < usable.length; i++) {
    run = isContiguous(usable[i - 1], usable[i]) ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * Asserts revenue + other income === total income wherever all three are
 * reported, and returns a note when they disagree.
 */
function assertRevenueIdentity(quarters: RawPeriod[]): string | null {
  for (const q of quarters) {
    const { revenue, otherIncome, totalIncome } = q;
    if (revenue === null || otherIncome === null || totalIncome === null) continue;
    const expected = revenue + otherIncome;
    if (totalIncome === 0) continue;
    if (Math.abs(expected - totalIncome) / Math.abs(totalIncome) > 0.005) {
      return "the reported revenue, other income and total income lines do not add up in at least one quarter, so revenue has been taken from the operating line only";
    }
  }
  return null;
}

function deriveRoe(
  quarters: RawPeriod[],
  currency: string,
  mixedBasisNote: string,
): Metric {
  // Preferred: every quarter of the window carries both legs, so the
  // denominator is a four-point average across exactly the span the
  // numerator covers.
  //
  // Fallback: the window carries net income throughout but a balance sheet
  // only at some of its ends. That is not a degraded case, it is the normal
  // one outside the US — SEBI requires an Indian company to publish a balance
  // sheet twice a year, so no Indian company will ever have four, and return
  // on equity was unreportable for all of them. Opening-and-closing average
  // equity is the textbook denominator, not an approximation of one; two
  // observations inside the window are enough, and the label says how many
  // were used.
  const window = findWindow(quarters, ["netIncome", "equity"]) ?? findWindow(quarters, ["netIncome"]);
  if (!window) {
    return missing(
      "TTM unavailable",
      currency,
      "return on equity needs four contiguous quarters reporting net income",
    );
  }
  if (window.mixedBasis) return missing(ttmLabel(window), currency, mixedBasisNote);

  const equities = window.quarters
    .filter((q) => q.equity !== null)
    .map((q) => q.equity as number);
  if (equities.length < MIN_EQUITY_OBSERVATIONS) {
    return missing(
      ttmLabel(window),
      currency,
      `return on equity needs at least ${MIN_EQUITY_OBSERVATIONS} balance sheets inside the window to average; this one carries ${equities.length}`,
    );
  }

  const averageEquity = equities.reduce((a, b) => a + b, 0) / equities.length;
  if (averageEquity === 0) {
    return missing(ttmLabel(window), currency, "average shareholders' equity is zero");
  }
  return ok(
    sum(window, "netIncome") / averageEquity,
    `${ttmLabel(window)}, average of the ${equities.length} balance sheets filed in the window`,
    window.basis,
    currency,
    derivedFrom(window, ["net income", "shareholders' equity (averaged)"]),
  );
}

/** Below two, the denominator is a point in time rather than an average. */
const MIN_EQUITY_OBSERVATIONS = 2;

/**
 * A forward multiple, or nothing.
 *
 * Emitted ONLY with the estimate's fiscal year named in `period`. A bare
 * "forward P/E" is never produced: the provider's own unlabelled forwardEps
 * field turns out to be the estimate for the year AFTER next (TCS 162.50 for
 * the year ending March 2028; NVDA 15.46 for the year ending January 2028),
 * so publishing it without a year understates the multiple by a full year of
 * expected growth.
 */
function deriveForwardPe(
  statements: RawStatements,
  profile: ReportingProfile,
  price: number | null,
  currencyComparable: boolean,
  marketCurrency: string,
): Metric {
  const dated = statements.forward
    .filter((f) => f.epsAvg !== null && f.periodEnd !== null)
    .sort((a, b) => (a.periodEnd as string).localeCompare(b.periodEnd as string));
  const next = dated[0];

  if (!next) {
    return missing(
      "forward fiscal year unknown",
      marketCurrency,
      "no forward estimate carries the fiscal year it applies to, so a forward multiple cannot be labelled",
    );
  }
  if (!currencyComparable) {
    return missing(
      formatFiscalYearLabel(next.periodEnd as string, profile),
      marketCurrency,
      "the quoted price and the estimate are in different currencies, so a multiple cannot be formed",
    );
  }
  if (price === null) {
    return missing(formatFiscalYearLabel(next.periodEnd as string, profile), marketCurrency, "no price was reported");
  }
  const eps = next.epsAvg as number;
  if (eps <= 0) {
    return missing(
      formatFiscalYearLabel(next.periodEnd as string, profile),
      marketCurrency,
      "the forward estimate is not positive, so a forward multiple is not meaningful",
    );
  }
  return ok(
    price / eps,
    `consensus estimate for ${formatFiscalYearLabel(next.periodEnd as string, profile)}`,
    "unknown",
    marketCurrency,
    ["price ÷ consensus earnings per share for the named fiscal year"],
  );
}

function q4LumpinessNote(window: Window | null, profile: ReportingProfile): string | null {
  if (!window) return null;
  const containsQ4 = window.quarters.some(
    (q) => Number(q.periodEnd.slice(5, 7)) === profile.fiscalYearEndMonth,
  );
  return containsQ4
    ? "this window includes the fourth quarter, which is published as the balancing figure against the audited year, so year-end adjustments may sit inside it"
    : null;
}
