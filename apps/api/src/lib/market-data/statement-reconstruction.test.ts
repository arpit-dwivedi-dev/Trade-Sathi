import { describe, expect, it } from "vitest";
import { reconstructMissingQuarters } from "./statement-reconstruction.js";
import type { RawPeriod } from "./statements.js";

/**
 * Gap reconstruction has TWO shapes, and only one of them is about a quarter
 * that is missing outright.
 *
 * A regression here is expensive and quiet: when this ran per PERIOD instead
 * of per LINE, every quarter that existed but reported only some of its lines
 * was treated as complete, and TCS lost trailing operating cash flow, capex,
 * free cash flow, both margins and the cash payout ratio at once — with no
 * error anywhere, just a report full of "missing".
 */

function period(over: Partial<RawPeriod> & { periodEnd: string; months: 3 | 12 }): RawPeriod {
  return {
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

/** An Indian fiscal year: quarters ending Jun, Sep, Dec, Mar. */
const FY_QUARTER_ENDS = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];
const FY_END = "2026-03-31";

describe("reconstructMissingQuarters", () => {
  it("fills a single line missing from a quarter that is otherwise present", () => {
    // The real TCS shape: 2025-09-30 arrives from quoteSummary with revenue
    // and net income but no cash-flow line.
    const quarters = FY_QUARTER_ENDS.map((end) =>
      period({
        periodEnd: end,
        months: 3,
        revenue: 100,
        operatingCashFlow: end === "2025-09-30" ? null : 20,
      }),
    );
    const annual = [period({ periodEnd: FY_END, months: 12, revenue: 400, operatingCashFlow: 90 })];

    const result = reconstructMissingQuarters(quarters, annual);

    const filled = result.find((q) => q.periodEnd === "2025-09-30");
    expect(filled?.operatingCashFlow).toBe(30); // 90 − (20 + 20 + 20)
    // The quarter already existed, so nothing new was synthesized.
    expect(result).toHaveLength(4);
  });

  it("leaves a line alone when TWO quarters of the year lack it", () => {
    const quarters = FY_QUARTER_ENDS.map((end) =>
      period({
        periodEnd: end,
        months: 3,
        operatingCashFlow: end === "2025-09-30" || end === "2025-12-31" ? null : 20,
      }),
    );
    const annual = [period({ periodEnd: FY_END, months: 12, operatingCashFlow: 90 })];

    const result = reconstructMissingQuarters(quarters, annual);

    // Two unknowns, one equation — underdetermined, so nothing is inferred.
    for (const q of result) {
      if (q.periodEnd === "2025-09-30" || q.periodEnd === "2025-12-31") {
        expect(q.operatingCashFlow).toBeNull();
      }
    }
  });

  it("still synthesizes a fiscal-year-end quarter that was never filed at all", () => {
    // The US shape: Q4 exists only inside the 10-K.
    const quarters = FY_QUARTER_ENDS.slice(0, 3).map((end) =>
      period({ periodEnd: end, months: 3, revenue: 100 }),
    );
    const annual = [period({ periodEnd: FY_END, months: 12, revenue: 450 })];

    const result = reconstructMissingQuarters(quarters, annual);

    const q4 = result.find((q) => q.periodEnd === FY_END);
    expect(q4?.revenue).toBe(150); // 450 − 300
    expect(q4?.reconstructed).toBe(true);
    expect(result).toHaveLength(4);
  });

  it("never reconstructs a balance-sheet line, which does not sum across a year", () => {
    const quarters = FY_QUARTER_ENDS.map((end) =>
      period({ periodEnd: end, months: 3, equity: end === "2025-09-30" ? null : 1_000 }),
    );
    const annual = [period({ periodEnd: FY_END, months: 12, equity: 1_000 })];

    const result = reconstructMissingQuarters(quarters, annual);

    expect(result.find((q) => q.periodEnd === "2025-09-30")?.equity).toBeNull();
  });

  it("does not pull the previous year's closing quarter into this year's four", () => {
    // 2025-03-31 closes the PRIOR fiscal year and must not be counted here,
    // which would make five quarters and suppress the fill.
    const quarters = [
      period({ periodEnd: "2025-03-31", months: 3, revenue: 90, operatingCashFlow: 15 }),
      ...FY_QUARTER_ENDS.map((end) =>
        period({
          periodEnd: end,
          months: 3,
          revenue: 100,
          operatingCashFlow: end === "2025-09-30" ? null : 20,
        }),
      ),
    ];
    const annual = [period({ periodEnd: FY_END, months: 12, revenue: 400, operatingCashFlow: 90 })];

    const result = reconstructMissingQuarters(quarters, annual);

    expect(result.find((q) => q.periodEnd === "2025-09-30")?.operatingCashFlow).toBe(30);
  });
});
