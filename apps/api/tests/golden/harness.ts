import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DerivedMetricKey, DerivedMetrics } from "@chartanalyzer/shared";
import type { RawPeriod, RawStatements } from "../../src/lib/market-data/statements.js";
import { deriveMetrics } from "../../src/services/fundamentals/derive-metrics.js";
import { runPlausibilityGate } from "../../src/services/fundamentals/plausibility.js";
import { resolveReportingProfile } from "../../src/services/fundamentals/reporting-profile.js";

/**
 * Shared rig for the golden set.
 *
 * Fixtures are RAW statements captured verbatim from the upstream endpoints
 * and committed as JSON, so the whole golden set runs with NO NETWORK — the
 * derivation and validation path is required to be pure, and a test that
 * reached upstream would both violate that and drift every time a price
 * moved.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface Fixture {
  symbol: string;
  exchange: string;
  slug: string;
  statements: RawStatements;
}

export function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${slug}.json`), "utf8")) as Fixture;
}

export function allFixtureSlugs(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/**
 * A fixed clock. Staleness rules compare against "now", so without pinning it
 * every fixture would start failing the day it aged past a threshold.
 */
export const FIXED_NOW = new Date("2026-09-05T00:00:00Z");

export function runPipeline(fixture: Fixture) {
  const { statements } = fixture;
  const latestAnnual = statements.annual[statements.annual.length - 1];
  const profile = resolveReportingProfile({
    exchange: fixture.exchange,
    fiscalYearEndMonthFromFilings: latestAnnual
      ? Number(latestAnnual.periodEnd.slice(5, 7))
      : null,
    reportingCurrency: statements.spot.financialCurrency,
  });
  const metrics = deriveMetrics({ statements, profile });
  const gate = runPlausibilityGate({ metrics, statements, profile, now: FIXED_NOW });
  return { profile, metrics: gate.metrics, dataNotes: gate.dataNotes, findings: gate.findings };
}

/**
 * The snapshot view of one metric.
 *
 * Period, basis and reliability are snapshotted alongside the value on
 * purpose: a right number carrying a wrong period label is exactly the defect
 * this rebuild exists to remove, and a snapshot of the value alone would pass
 * straight through it.
 */
export function snapshotMetric(metrics: DerivedMetrics, key: DerivedMetricKey) {
  const m = metrics[key];
  return {
    value: m.value === null ? null : round(m.value),
    period: m.period,
    basis: m.basis,
    reliability: m.reliability,
    ...(m.fxUnadjusted ? { fxUnadjusted: true } : {}),
  };
}

export function snapshotAll(metrics: DerivedMetrics) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metrics).sort() as DerivedMetricKey[]) {
    out[key] = snapshotMetric(metrics, key);
  }
  return out;
}

/** Six significant figures — enough to catch a real change, not float noise. */
function round(value: number): number {
  if (value === 0) return 0;
  return Number(value.toPrecision(6));
}

// ---------------------------------------------------------------------------
// Synthetic fixture builder — for the structural cases upstream cannot supply
// ---------------------------------------------------------------------------

export function quarter(periodEnd: string, over: Partial<RawPeriod> = {}): RawPeriod {
  return {
    periodEnd,
    months: 3,
    basis: "consolidated",
    currency: "INR",
    source: "yahoo",
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
    ...over,
  };
}

export function syntheticStatements(
  quarters: RawPeriod[],
  over: Partial<RawStatements> = {},
): RawStatements {
  return {
    quarterly: quarters,
    annual: [],
    spot: {
      price: 100,
      asOf: "2026-09-04T10:00:00.000Z",
      marketCap: null,
      currency: "INR",
      financialCurrency: "INR",
      dividendDeclaredPerShare: null,
      dividendYield: null,
      mostRecentQuarter: quarters[quarters.length - 1]?.periodEnd ?? null,
    },
    forward: [],
    corporateActions: [],
    ...over,
  };
}

/** Eight contiguous March-quarter ends, oldest first. */
export const EIGHT_QUARTER_ENDS = [
  "2024-09-30",
  "2024-12-31",
  "2025-03-31",
  "2025-06-30",
  "2025-09-30",
  "2025-12-31",
  "2026-03-31",
  "2026-06-30",
];
