import type { RawPeriod } from "./statements.js";

/**
 * Gap-filling shared by every statement adapter: one missing quarterly FLOW
 * figure, backed out as (fiscal year − the other three quarters of that
 * year). Extracted from the original Yahoo-only implementation so SEC EDGAR
 * (10-K minus Q1-Q3) can reuse the identical, already-validated method for
 * its own Q4 gap.
 *
 * SAME-BASIS ALWAYS, SAME-SOURCE UNLESS THE SOURCES WERE PROVED EQUIVALENT
 *
 * Every adapter applies this to its own read, where one source's figures are
 * trivially comparable. It is applied ONCE MORE to the merged statements,
 * where they are not trivially comparable and so must have been proved: the
 * merge only ever hands over a series whose sources agreed period for period
 * on the figures they both report (see statements-merge.ts). Without that
 * second pass a fiscal year can be complete across the sources and incomplete
 * within each of them, and nothing fills it — ITC's December 2024 revenue
 * survives in nobody's quarterly history but is implied exactly by the
 * audited year and the other three quarters, and its absence cost the company
 * every trailing growth comparison.
 *
 * Basis is checked here regardless: a year and a quarter filed on different
 * bases are never subtracted, whatever their provenance.
 */

export const RECONSTRUCTABLE_LINES = [
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

/**
 * Fills a line that is the arithmetic of two others in the SAME period.
 *
 * Strictly period-local: every input comes from one period of one source, so
 * this restates a filer's own subtotal rather than combining anything. Only
 * ever writes where the line is absent.
 *
 * Gross profit is the case that matters. It is an optional subtotal under US
 * GAAP and plenty of large filers never tag it — Costco last did in 2019 and
 * Procter & Gamble never has — while both report revenue and cost of revenue
 * in every filing. Their gross profit and gross margin were missing out of
 * statements that state both operands.
 */
export function applyPeriodIdentities(periods: RawPeriod[]): RawPeriod[] {
  return periods.map((period) => {
    const { revenue, costOfRevenue, grossProfit } = period;
    if (grossProfit !== null || revenue === null || costOfRevenue === null) return period;
    return { ...period, grossProfit: revenue - costOfRevenue };
  });
}

/** An empty quarter, ready to be filled in. */
export function blankQuarter(periodEnd: string, template: RawPeriod): RawPeriod {
  return {
    periodEnd,
    months: 3,
    basis: template.basis,
    currency: template.currency,
    source: template.source,
    filingDate: null,
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

/** Same tolerance derive-metrics.ts uses to decide two periods are consecutive quarters. */
const MIN_QUARTER_GAP_DAYS = 80;
/** A 16-week fiscal quarter is 112 days; see derive-metrics.ts. */
const MAX_QUARTER_GAP_DAYS = 120;

function daysBetween(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * The three ACTUAL quarters immediately preceding `yearEnd` that chain up to
 * it — each 80-100 days from the next — or `null` if fewer than three such
 * quarters exist.
 *
 * Deliberately NOT computed from calendar-month arithmetic: a 52/53-week
 * fiscal filer (NVDA files quarters ending "2025-07-27", not "2025-07-31")
 * would never match a hypothetical exact-month-end date, and every one of
 * its Q4-from-10-K gaps would silently fail to reconstruct. Walking backward
 * from the fiscal year's own reported end date by the real gap between
 * consecutive filings works for both a calendar-month filer (TCS) and a
 * 52/53-week one (NVDA) without needing to know which kind a company is.
 */
function precedingQuarterChain(yearEnd: string, quarters: RawPeriod[]): RawPeriod[] | null {
  const candidates = quarters
    .filter((q) => q.periodEnd < yearEnd)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));

  const chain: RawPeriod[] = [];
  let anchor = yearEnd;
  for (const q of candidates) {
    const gap = daysBetween(q.periodEnd, anchor);
    if (gap < MIN_QUARTER_GAP_DAYS || gap > MAX_QUARTER_GAP_DAYS) break;
    chain.push(q);
    anchor = q.periodEnd;
    if (chain.length === 3) break;
  }
  return chain.length === 3 ? chain : null;
}

/**
 * The quarters belonging to the fiscal year ending on `yearEnd`.
 *
 * Selected by a date WINDOW rather than by predicting the four quarter-end
 * dates: a 52/53-week filer's quarters land on dates no calendar arithmetic
 * reproduces, and a quarter that is missing entirely cannot be matched by
 * exact date at all. The window stops short of a full year so the PRIOR
 * year's closing quarter, roughly 365 days back, can never be pulled in
 * alongside this year's four.
 */
export function quartersOfFiscalYear(yearEnd: string, quarters: RawPeriod[]): RawPeriod[] {
  return quarters
    .filter((q) => q.periodEnd <= yearEnd && daysBetween(q.periodEnd, yearEnd) < FISCAL_YEAR_WINDOW_DAYS)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/**
 * Comfortably past a fiscal year's first quarter end (~273 days back) and
 * comfortably short of the previous year's close (~365 days back).
 */
const FISCAL_YEAR_WINDOW_DAYS = 340;

/**
 * Fills a missing quarterly FLOW figure as (fiscal year − the other three
 * quarters of that year).
 *
 * Applied PER LINE, not per period. Coverage is ragged within a quarter as
 * well as across quarters: a quarter can arrive carrying revenue and net
 * income but no operating income, no cash flow and no dividend line, so a
 * whole-period test would see the quarter as present and leave several
 * trailing metrics unresolvable. Per line, the same fiscal year reconstructs
 * each of those from the audited annual figure.
 *
 * Only ever applied where exactly three OTHER quarters of the fiscal year
 * chain up to it (each 80-100 days apart) and none of the four is already
 * reported — with any other shape the system is underdetermined and nothing
 * is inferred.
 *
 * Flow lines only. A balance-sheet figure is a point-in-time stock and does
 * not sum across a year, so equity, debt, cash and share counts are never
 * reconstructed this way.
 */
export function reconstructMissingQuarters(
  quarters: RawPeriod[],
  annual: RawPeriod[],
): RawPeriod[] {
  if (annual.length === 0) return quarters;

  const byEnd = new Map(quarters.map((q) => [q.periodEnd, q]));

  for (const year of annual) {
    const reported = quartersOfFiscalYear(year.periodEnd, [...byEnd.values()]);

    for (const line of RECONSTRUCTABLE_LINES) {
      const annualValue = year[line];
      if (annualValue === null) continue;

      // CASE 1 — all four quarters of the year are present, but one of them
      // does not report THIS line. Coverage is ragged within a quarter as
      // well as across quarters: TCS's 2025-09-30 arrives from quoteSummary
      // carrying revenue and net income but no operating income, no cash flow
      // and no dividend line. A whole-period test sees that quarter as
      // present and leaves several trailing metrics unresolvable, which is
      // why this runs per line rather than per period.
      if (reported.length === 4) {
        if (reported.some((q) => q.basis !== year.basis)) continue;
        const missing = reported.filter((q) => q[line] === null);
        if (missing.length !== 1) continue;
        const sumOfThree = reported.reduce((total, q) => total + (q[line] ?? 0), 0);
        missing[0][line] = annualValue - sumOfThree;
        continue;
      }

      // CASE 2 — the year's last quarter was never filed at all, the usual
      // shape for a US filer whose Q4 exists only inside the 10-K. Only ever
      // applied where exactly three OTHER quarters chain up to the year end;
      // with any other shape the system is underdetermined and nothing is
      // inferred.
      if (reported.length !== 3 || byEnd.has(year.periodEnd)) continue;
      const chain = precedingQuarterChain(year.periodEnd, quarters);
      if (!chain || chain.some((q) => q[line] === null || q.basis !== year.basis)) continue;

      const sumOfChain = chain.reduce((total, q) => total + (q[line] as number), 0);
      const quarter = byEnd.get(year.periodEnd) ?? blankQuarter(year.periodEnd, year);
      quarter[line] = annualValue - sumOfChain;
      byEnd.set(year.periodEnd, quarter);
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
