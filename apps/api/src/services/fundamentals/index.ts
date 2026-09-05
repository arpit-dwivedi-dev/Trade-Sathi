import type { DerivedFundamentals } from "@chartanalyzer/shared";
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
    dataNotes,
    findings,
    quartersUsed: statements.quarterly.map((q) => q.periodEnd),
  };
}

export { deriveMetrics } from "./derive-metrics.js";
export { runPlausibilityGate } from "./plausibility.js";
export { buildFacts, buildThresholds } from "./report-facts.js";
export { formatFiscalYearLabel, resolveReportingProfile } from "./reporting-profile.js";
export { formatAmount, formatPercent } from "./display.js";
