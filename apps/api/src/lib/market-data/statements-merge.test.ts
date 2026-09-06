import { describe, expect, it } from "vitest";
import { mergeStatementSources } from "./statements-merge.js";
import type { RawPeriod, RawStatements } from "./statements.js";

function period(over: Partial<RawPeriod> & { periodEnd: string }): RawPeriod {
  return {
    months: 3,
    basis: "consolidated",
    currency: "USD",
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

function statements(over: Partial<RawStatements> = {}): RawStatements {
  return {
    quarterly: [],
    annual: [],
    spot: {
      price: null,
      asOf: null,
      marketCap: null,
      currency: null,
      financialCurrency: null,
      dividendDeclaredPerShare: null,
      dividendYield: null,
      mostRecentQuarter: null,
    },
    forward: [],
    corporateActions: null,
    ...over,
  };
}

describe("mergeStatementSources", () => {
  it("prefers the higher-priority source's whole period when both report the same quarter", () => {
    const official = statements({
      quarterly: [period({ periodEnd: "2026-03-31", source: "sec-edgar", revenue: 100 })],
    });
    const yahoo = statements({
      quarterly: [period({ periodEnd: "2026-03-31", source: "yahoo", revenue: 999 })],
    });

    const merged = mergeStatementSources([official, yahoo]);

    expect(merged.quarterly).toHaveLength(1);
    expect(merged.quarterly[0].source).toBe("sec-edgar");
    expect(merged.quarterly[0].revenue).toBe(100);
  });

  it("treats a same-quarter period a few days apart as a duplicate, not a new period", () => {
    // Verified against live data: SEC EDGAR reports NVDA's actual fiscal
    // quarter end ("2025-04-27") while Yahoo's own quarterly history
    // normalises the same real quarter to calendar month-end ("2025-04-30").
    // An exact-date dedup would let both survive, breaking the 80-100-day
    // contiguity window derive-metrics.ts relies on to build a TTM.
    const official = statements({
      quarterly: [period({ periodEnd: "2025-04-27", source: "sec-edgar", revenue: 100 })],
    });
    const yahoo = statements({
      quarterly: [period({ periodEnd: "2025-04-30", source: "yahoo", revenue: 999 })],
    });

    const merged = mergeStatementSources([official, yahoo]);

    expect(merged.quarterly).toHaveLength(1);
    expect(merged.quarterly[0].source).toBe("sec-edgar");
    expect(merged.quarterly[0].periodEnd).toBe("2025-04-27");
    expect(merged.quarterly[0].revenue).toBe(100);
  });

  it("does not merge two genuinely consecutive quarters even when reported close to a boundary", () => {
    const official = statements({
      quarterly: [
        period({ periodEnd: "2025-01-26", source: "sec-edgar", revenue: 100 }),
        period({ periodEnd: "2025-04-27", source: "sec-edgar", revenue: 200 }),
      ],
    });

    const merged = mergeStatementSources([official]);

    expect(merged.quarterly).toHaveLength(2);
  });

  it("fills a gap in the official source from Yahoo", () => {
    const official = statements({
      quarterly: [
        period({ periodEnd: "2025-12-31", source: "sec-edgar", revenue: 100 }),
        period({ periodEnd: "2026-06-30", source: "sec-edgar", revenue: 300 }),
      ],
    });
    const yahoo = statements({
      quarterly: [
        period({ periodEnd: "2025-12-31", source: "yahoo", revenue: 1 }),
        period({ periodEnd: "2026-03-31", source: "yahoo", revenue: 200 }),
        period({ periodEnd: "2026-06-30", source: "yahoo", revenue: 3 }),
      ],
    });

    const merged = mergeStatementSources([official, yahoo]);

    expect(merged.quarterly.map((q) => [q.periodEnd, q.source, q.revenue])).toEqual([
      ["2025-12-31", "sec-edgar", 100],
      ["2026-03-31", "yahoo", 200],
      ["2026-06-30", "sec-edgar", 300],
    ]);
  });

  it("deduplicates by (periodEnd, months) — an annual and quarterly period with the same end date both survive", () => {
    const official = statements({
      quarterly: [period({ periodEnd: "2026-03-31", months: 3, source: "sec-edgar", revenue: 100 })],
      annual: [period({ periodEnd: "2026-03-31", months: 12, source: "sec-edgar", revenue: 400 })],
    });

    const merged = mergeStatementSources([official]);

    expect(merged.quarterly).toHaveLength(1);
    expect(merged.annual).toHaveLength(1);
    expect(merged.annual[0].revenue).toBe(400);
  });

  it("merges quarterly and annual arrays independently", () => {
    const official = statements({
      quarterly: [period({ periodEnd: "2026-03-31", source: "sec-edgar", revenue: 100 })],
      annual: [],
    });
    const yahoo = statements({
      quarterly: [],
      annual: [period({ periodEnd: "2026-03-31", months: 12, source: "yahoo", revenue: 400 })],
    });

    const merged = mergeStatementSources([official, yahoo]);

    expect(merged.quarterly).toHaveLength(1);
    expect(merged.quarterly[0].source).toBe("sec-edgar");
    expect(merged.annual).toHaveLength(1);
    expect(merged.annual[0].source).toBe("yahoo");
  });

  it("takes spot/forward/corporateActions from the source that actually has them", () => {
    const official = statements({ quarterly: [period({ periodEnd: "2026-03-31" })] });
    const yahoo = statements({
      spot: {
        price: 123,
        asOf: "2026-09-04T10:00:00.000Z",
        marketCap: 1000,
        currency: "USD",
        financialCurrency: "USD",
        dividendDeclaredPerShare: null,
        dividendYield: null,
        mostRecentQuarter: "2026-03-31",
      },
      forward: [{ epsAvg: 1, periodEnd: "2027-03-31" }],
      corporateActions: [],
    });

    const merged = mergeStatementSources([official, yahoo]);

    expect(merged.spot.price).toBe(123);
    expect(merged.forward).toHaveLength(1);
    expect(merged.corporateActions).toEqual([]);
  });

  describe("basis proved by reconciliation", () => {
    // An Indian fiscal year: the official source files Jun/Sep/Dec, the
    // vendor supplies March and the audited annual total.
    const FY_END = "2026-03-31";
    const officialQuarters = [
      period({ periodEnd: "2025-06-30", source: "nse-bse", basis: "consolidated", revenue: 100 }),
      period({ periodEnd: "2025-09-30", source: "nse-bse", basis: "consolidated", revenue: 110 }),
      period({ periodEnd: "2025-12-31", source: "nse-bse", basis: "consolidated", revenue: 120 }),
    ];

    it("adopts the official basis for vendor periods when the year adds up", () => {
      const official = statements({ quarterly: officialQuarters });
      const yahoo = statements({
        quarterly: [period({ periodEnd: FY_END, source: "yahoo", basis: "unknown", revenue: 130 })],
        annual: [
          period({ periodEnd: FY_END, months: 12, source: "yahoo", basis: "unknown", revenue: 460 }),
        ],
      });

      const merged = mergeStatementSources([official, yahoo]);

      // 100 + 110 + 120 + 130 === 460, so the vendor is on the same series.
      expect(merged.quarterly.find((q) => q.periodEnd === FY_END)?.basis).toBe("consolidated");
      // The proof carries to the vendor's whole series, annual included.
      expect(merged.annual[0].basis).toBe("consolidated");
    });

    it("leaves the basis unknown when the year does NOT add up", () => {
      const official = statements({ quarterly: officialQuarters });
      const yahoo = statements({
        quarterly: [period({ periodEnd: FY_END, source: "yahoo", basis: "unknown", revenue: 130 })],
        // A standalone annual total: far short of the consolidated quarters.
        annual: [
          period({ periodEnd: FY_END, months: 12, source: "yahoo", basis: "unknown", revenue: 300 }),
        ],
      });

      const merged = mergeStatementSources([official, yahoo]);

      expect(merged.quarterly.find((q) => q.periodEnd === FY_END)?.basis).toBe("unknown");
      expect(merged.annual[0].basis).toBe("unknown");
    });

    it("never overrides a basis a source actually stated", () => {
      const official = statements({ quarterly: officialQuarters });
      const other = statements({
        quarterly: [period({ periodEnd: FY_END, source: "yahoo", basis: "standalone", revenue: 130 })],
        annual: [
          period({ periodEnd: FY_END, months: 12, source: "yahoo", basis: "unknown", revenue: 460 }),
        ],
      });

      const merged = mergeStatementSources([official, other]);

      // It reconciles, but this period declared its own basis — untouched.
      expect(merged.quarterly.find((q) => q.periodEnd === FY_END)?.basis).toBe("standalone");
    });

    it("leaves everything alone when no source ever states a basis", () => {
      const yahoo = statements({
        quarterly: [
          period({ periodEnd: "2025-06-30", source: "yahoo", basis: "unknown", revenue: 100 }),
          period({ periodEnd: FY_END, source: "yahoo", basis: "unknown", revenue: 130 }),
        ],
      });

      const merged = mergeStatementSources([yahoo]);

      expect(merged.quarterly.every((q) => q.basis === "unknown")).toBe(true);
    });
  });

  it("sorts the merged arrays oldest-first regardless of input order", () => {
    const source = statements({
      quarterly: [
        period({ periodEnd: "2026-06-30" }),
        period({ periodEnd: "2025-12-31" }),
        period({ periodEnd: "2026-03-31" }),
      ],
    });

    const merged = mergeStatementSources([source]);

    expect(merged.quarterly.map((q) => q.periodEnd)).toEqual(["2025-12-31", "2026-03-31", "2026-06-30"]);
  });
});
