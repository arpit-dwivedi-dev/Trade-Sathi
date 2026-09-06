import { describe, expect, it } from "vitest";
import type { RawPeriod, RawStatements } from "../../src/lib/market-data/statements.js";
import { deriveFundamentals } from "../../src/services/fundamentals/index.js";
import { EIGHT_QUARTER_ENDS, quarter, syntheticStatements } from "./harness.js";

/**
 * What the derivation layer actually hands the prompt, as opposed to what it
 * computes. Both cases here were reported as "missing information" in a live
 * report while the underlying data was present and correct:
 *
 * - a USD-denominated revenue growth figure was emitted as 'missing' for
 *   every instrument by design, listing a metric no source files at all as a
 *   data gap. The FX caveat it existed to raise belongs on the growth figures
 *   themselves, which is where it now lives.
 * - the annual statements never reached the payload at all, so a report could
 *   not describe multi-year history no matter how many years were fetched.
 */

const EIGHT_QUARTERS = EIGHT_QUARTER_ENDS.map((end, i) =>
  quarter(end, {
    revenue: 1_000 + i * 100,
    totalIncome: 1_000 + i * 100,
    netIncome: 100 + i * 10,
  }),
);

function year(periodEnd: string, over: Partial<RawPeriod> = {}): RawPeriod {
  return quarter(periodEnd, { months: 12, ...over });
}

function usd(statements: RawStatements): RawStatements {
  return {
    ...statements,
    quarterly: statements.quarterly.map((q) => ({ ...q, currency: "USD" })),
    annual: statements.annual.map((a) => ({ ...a, currency: "USD" })),
    spot: { ...statements.spot, currency: "USD", financialCurrency: "USD" },
  };
}

describe("the FX caveat on growth", () => {
  it("emits no USD-revenue metric for a USD filer, where there is nothing to isolate", () => {
    const derived = deriveFundamentals(usd(syntheticStatements(EIGHT_QUARTERS)), "NASDAQ");

    expect("revenueGrowthUsd" in derived.metrics).toBe(false);
    expect(derived.metrics.revenueGrowth.reliability).toBe("ok");
    expect(derived.metrics.revenueGrowth.fxUnadjusted).toBeUndefined();
  });

  it("emits none for a non-USD filer either — it rides on the growth figure instead", () => {
    const derived = deriveFundamentals(syntheticStatements(EIGHT_QUARTERS), "NSE");

    // No source this pipeline reads files a USD revenue line, so a metric for
    // it could only ever be missing — a permanent gap, reported as a data
    // quality problem on every rupee filer.
    expect("revenueGrowthUsd" in derived.metrics).toBe(false);
    // The caveat is not lost: it is stamped on the figure it qualifies.
    expect(derived.metrics.revenueGrowth.reliability).toBe("ok");
    expect(derived.metrics.revenueGrowth.fxUnadjusted).toBe(true);
    expect(derived.metrics.revenueGrowth.note).toMatch(/FX effects not isolated/);
    expect(derived.metrics.earningsGrowth.fxUnadjusted).toBe(true);
  });
});

describe("annualHistory", () => {
  it("carries the recent audited fiscal years, oldest first", () => {
    const statements = syntheticStatements(EIGHT_QUARTERS, {
      annual: [
        year("2023-03-31", { revenue: 4_000, netIncome: 400 }),
        year("2024-03-31", { revenue: 5_000, netIncome: 500 }),
        year("2025-03-31", { revenue: 6_000, netIncome: 600 }),
      ],
    });

    const { annualHistory } = deriveFundamentals(statements, "NSE");

    expect(annualHistory.map((a) => a.periodEnd)).toEqual([
      "2023-03-31",
      "2024-03-31",
      "2025-03-31",
    ]);
    expect(annualHistory[0].revenue).toBe(4_000);
    expect(annualHistory[0].basis).toBe("consolidated");
  });

  it("keeps only the five most recent years, so the oldest and least comparable are dropped", () => {
    const ends = [
      "2019-03-31",
      "2020-03-31",
      "2021-03-31",
      "2022-03-31",
      "2023-03-31",
      "2024-03-31",
      "2025-03-31",
    ];
    const statements = syntheticStatements(EIGHT_QUARTERS, {
      annual: ends.map((end, i) => year(end, { revenue: 1_000 * (i + 1), netIncome: 100 })),
    });

    const { annualHistory } = deriveFundamentals(statements, "NSE");

    expect(annualHistory).toHaveLength(5);
    expect(annualHistory.map((a) => a.periodEnd)).toEqual(ends.slice(-5));
  });

  it("drops a year reporting neither revenue nor net income, which carries no trend", () => {
    const statements = syntheticStatements(EIGHT_QUARTERS, {
      annual: [
        year("2023-03-31", { revenue: null, netIncome: null, equity: 9_000 }),
        year("2024-03-31", { revenue: 5_000, netIncome: 500 }),
      ],
    });

    const { annualHistory } = deriveFundamentals(statements, "NSE");

    expect(annualHistory.map((a) => a.periodEnd)).toEqual(["2024-03-31"]);
  });

  it("is empty, not absent, when no annual statements were supplied", () => {
    const { annualHistory } = deriveFundamentals(syntheticStatements(EIGHT_QUARTERS), "NSE");

    expect(annualHistory).toEqual([]);
  });
});
