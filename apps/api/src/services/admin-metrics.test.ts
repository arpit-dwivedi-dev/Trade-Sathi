import { describe, expect, it } from "vitest";
import {
  analysisTrend,
  breakdown,
  estimatedPnlUsd,
  foldEconomics,
  parseRange,
  paymentTrend,
  rangeSince,
  summarizePayments,
  type AnalysisGroup,
  type PaymentGroup,
} from "./admin-metrics.js";

function payment(overrides: Partial<PaymentGroup>): PaymentGroup {
  return {
    day: "2026-09-20",
    currency: "INR",
    status: "captured",
    signature_verified: true,
    payments: 1,
    amount_minor: 0,
    ...overrides,
  };
}

function analysis(overrides: Partial<AnalysisGroup>): AnalysisGroup {
  return {
    day: "2026-09-20",
    source: "manual",
    model_id: "gemini",
    status: "complete",
    currency: "INR",
    analyses: 1,
    cost_usd: 0,
    credits: 1,
    revenue_minor: 900,
    ...overrides,
  };
}

describe("summarizePayments", () => {
  it("keeps INR and USD revenue separate", () => {
    const summary = summarizePayments([
      payment({ currency: "INR", amount_minor: 90000, payments: 2 }),
      payment({ currency: "USD", amount_minor: 1200 }),
    ]);
    expect(summary.revenue).toEqual({ INR: 90000, USD: 1200 });
    expect(summary.capturedCount).toBe(3);
  });

  it("counts every captured payment as revenue, however the capture was confirmed", () => {
    const summary = summarizePayments([
      payment({ amount_minor: 1000 }),
      payment({ amount_minor: 5000, signature_verified: false }),
      payment({ status: "failed", amount_minor: 7000, payments: 2 }),
      payment({ status: "created", amount_minor: 3000 }),
    ]);
    expect(summary.revenue).toEqual({ INR: 6000 });
    expect(summary.capturedCount).toBe(2);
    expect(summary.failedCount).toBe(2);
    expect(summary.createdCount).toBe(1);
    expect(summary.totalCount).toBe(5);
  });

  it("reports refunds beside revenue rather than inside it", () => {
    const summary = summarizePayments([
      payment({ amount_minor: 1000 }),
      payment({ status: "refunded", amount_minor: 400, currency: "USD" }),
    ]);
    expect(summary.revenue).toEqual({ INR: 1000 });
    expect(summary.refunded).toEqual({ USD: 400 });
    expect(summary.refundedCount).toBe(1);
  });
});

describe("paymentTrend", () => {
  it("is per day, per currency, revenue only, in date order", () => {
    const trend = paymentTrend([
      payment({ day: "2026-09-21", amount_minor: 100 }),
      payment({ day: "2026-09-20", amount_minor: 200, currency: "USD" }),
      payment({ day: "2026-09-20", amount_minor: 300 }),
      payment({ day: "2026-09-20", status: "failed", amount_minor: 999 }),
    ]);
    expect(trend).toEqual([
      { day: "2026-09-20", revenue: { USD: 200, INR: 300 } },
      { day: "2026-09-21", revenue: { INR: 100 } },
    ]);
  });
});

describe("foldEconomics", () => {
  it("sums AI cost and keeps revenue by currency", () => {
    const totals = foldEconomics([
      analysis({ analyses: 2, cost_usd: 0.02, credits: 2, revenue_minor: 1800 }),
      analysis({ currency: "USD", cost_usd: 0.01, revenue_minor: 12 }),
    ]);
    expect(totals.analyses).toBe(3);
    expect(totals.credits).toBe(3);
    expect(totals.aiCostUsd).toBeCloseTo(0.03);
    expect(totals.revenue).toEqual({ INR: 1800, USD: 12 });
    expect(totals.avgCostUsd).toBeCloseTo(0.01);
    expect(totals.avgRevenue).toEqual({ INR: 900, USD: 12 });
  });

  it("estimates P&L only against USD-priced analyses", () => {
    const totals = foldEconomics([
      analysis({ cost_usd: 5, revenue_minor: 90000 }),
      analysis({ currency: "USD", cost_usd: 0.05, revenue_minor: 12 }),
    ]);
    // $0.12 revenue - $0.05 cost; the INR analysis's $5 is not subtracted.
    expect(totals.estimatedPnlUsd).toBeCloseTo(0.07);
    expect(totals.aiCostUsdByCurrency["INR"]).toBe(5);
  });

  it("has no P&L figure when nothing is USD-priced", () => {
    expect(foldEconomics([analysis({})]).estimatedPnlUsd).toBeNull();
  });

  it("handles an empty window", () => {
    const totals = foldEconomics([]);
    expect(totals.analyses).toBe(0);
    expect(totals.avgCostUsd).toBeNull();
    expect(totals.revenue).toEqual({});
  });
});

describe("estimatedPnlUsd", () => {
  it("subtracts USD cost from USD revenue", () => {
    expect(estimatedPnlUsd("USD", 24, 0.1)).toBeCloseTo(0.14);
  });
  it("refuses to mix currencies", () => {
    expect(estimatedPnlUsd("INR", 900, 0.1)).toBeNull();
    expect(estimatedPnlUsd(null, 0, 0.1)).toBeNull();
  });
});

describe("breakdown and trend", () => {
  const groups = [
    analysis({ source: "manual", model_id: "a", cost_usd: 1 }),
    analysis({ source: "manual", model_id: "b", status: "failed", credits: 0, revenue_minor: 0 }),
    analysis({ source: "fundamentals", model_id: "a", day: "2026-09-19" }),
  ];

  it("groups by source and by model", () => {
    expect(breakdown(groups, "source").map((r) => [r.key, r.analyses])).toEqual([
      ["manual", 2],
      ["fundamentals", 1],
    ]);
    expect(breakdown(groups, "model_id").find((r) => r.key === "a")?.aiCostUsd).toBe(1);
  });

  it("builds a dated trend with failures", () => {
    expect(analysisTrend(groups).map((p) => [p.day, p.analyses, p.failed])).toEqual([
      ["2026-09-19", 1, 0],
      ["2026-09-20", 2, 1],
    ]);
  });
});

describe("ranges", () => {
  it("parses with a 30d default", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("all")).toBe("all");
    expect(parseRange("bogus")).toBe("30d");
    expect(parseRange(undefined)).toBe("30d");
  });
  it("computes the window start", () => {
    const now = new Date("2026-09-21T00:00:00Z");
    expect(rangeSince("7d", now)?.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(rangeSince("all", now)).toBeNull();
  });
});
