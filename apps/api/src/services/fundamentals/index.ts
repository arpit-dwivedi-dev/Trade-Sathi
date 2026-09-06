import type { AnnualHistoryEntry, DerivedFundamentals } from "@chartanalyzer/shared";
import type { RawStatements } from "../../lib/market-data/statements.js";
import { fiscalYearEndMonthFromStatements } from "../../lib/market-data/provider/yahoo-statements.js";
import { deriveMetrics } from "./derive-metrics.js";
import { runPlausibilityGate } from "./plausibility.js";
import { buildFacts } from "./report-facts.js";
import { resolveReportingProfile } from "./reporting-profile.js";

/**
 * The whole derivation path, in order: resolve the reporting profile, derive
 * every metric from raw statements, run the plausibility gate, then compute
 * the facts the prompt is handed.
 *
 * Pure and offline. No network call happens anywhere below this point — the
 * statements are fetched by the caller and everything here is arithmetic
 * over them.
 */
export function deriveFundamentals(
  statements: RawStatements,
  exchange: string,
): DerivedFundamentals {
  const profile = resolveReportingProfile({
    exchange,
    fiscalYearEndMonthFromFilings: fiscalYearEndMonthFromStatements(statements),
    reportingCurrency: statements.spot.financialCurrency,
    corporateActions: (statements.corporateActions ?? []).map((a) => a.kind),
  });

  const derived = deriveMetrics({ statements, profile });
  const { metrics, dataNotes, findings } = runPlausibilityGate({
    metrics: derived,
    statements,
    profile,
  });

  return {
    profile,
    metrics,
    facts: buildFacts(metrics),
    annualHistory: buildAnnualHistory(statements),
    dataNotes,
    findings,
    quartersUsed: statements.quarterly.map((q) => q.periodEnd),
  };
}

/** How many fiscal years of history a report reasons over. */
const ANNUAL_HISTORY_YEARS = 5;

/**
 * The recent audited fiscal years, for multi-year trend reading.
 *
 * Bounded rather than exhaustive. SEC EDGAR supplies eighteen years for NVDA
 * and the oldest of those are the least comparable — a filer changes the tag
 * it reports a line under between taxonomy versions, and restates — so the
 * window stops at five years, which is what a cyclical read actually needs.
 *
 * A year reporting neither revenue nor net income is dropped: it carries no
 * trend and would only invite the model to describe a gap as a downturn.
 */
function buildAnnualHistory(statements: RawStatements): AnnualHistoryEntry[] {
  return statements.annual
    .filter((year) => year.revenue !== null || year.netIncome !== null)
    .slice(-ANNUAL_HISTORY_YEARS)
    .map((year) => ({
      periodEnd: year.periodEnd,
      basis: year.basis,
      revenue: year.revenue,
      netIncome: year.netIncome,
      operatingIncome: year.operatingIncome,
      operatingCashFlow: year.operatingCashFlow,
    }));
}

export { deriveMetrics } from "./derive-metrics.js";
export { runPlausibilityGate } from "./plausibility.js";
export { buildFacts, buildThresholds } from "./report-facts.js";
export { formatFiscalYearLabel, resolveReportingProfile } from "./reporting-profile.js";
export { formatAmount, formatPercent } from "./display.js";
