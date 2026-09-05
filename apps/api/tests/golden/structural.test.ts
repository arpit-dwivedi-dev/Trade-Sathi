import type { RawStatements } from "../../src/lib/market-data/statements.js";
import { deriveMetrics } from "../../src/services/fundamentals/derive-metrics.js";
import { runPlausibilityGate } from "../../src/services/fundamentals/plausibility.js";
import { resolveReportingProfile } from "../../src/services/fundamentals/reporting-profile.js";
import {
  EIGHT_QUARTER_ENDS,
  FIXED_NOW,
  quarter,
  syntheticStatements,
} from "./harness.js";

/**
 * The structural cases upstream cannot supply.
 *
 * A bonus issue inside the window, a quarter filed on a different accounting
 * basis, and a clean eight-quarter history are all real reporting situations
 * that no live symbol currently exposes through this provider — it publishes
 * about five quarters and states no accounting basis at all. Constructing
 * them is the only way to prove the rules that govern them fire, and these
 * fixtures assert BEHAVIOUR of the derivation rules, not any company's
 * financials.
 */

const NSE_PROFILE = resolveReportingProfile({
  exchange: "NSE",
  fiscalYearEndMonthFromFilings: 3,
  reportingCurrency: "INR",
});

function derive(statements: RawStatements) {
  return deriveMetrics({ statements, profile: NSE_PROFILE });
}

/** Eight clean quarters with steadily rising revenue and earnings. */
function eightGoodQuarters(over: (i: number) => Partial<ReturnType<typeof quarter>> = () => ({})) {
  return EIGHT_QUARTER_ENDS.map((end, i) =>
    quarter(end, {
      revenue: 1_000 + i * 100,
      totalIncome: 1_000 + i * 100,
      netIncome: 100 + i * 10,
      operatingIncome: 200 + i * 20,
      grossProfit: 400 + i * 40,
      pretaxIncome: 130 + i * 13,
      operatingCashFlow: 150 + i * 15,
      capex: 20 + i,
      dividendsPaid: 10,
      equity: 2_000 + i * 100,
      totalDebt: 500,
      cash: 800,
      dilutedShares: 1_000,
      ...over(i),
    }),
  );
}

describe("eight contiguous quarters", () => {
  it("computes trailing growth against the prior trailing year", () => {
    const metrics = derive(syntheticStatements(eightGoodQuarters()));
    // Latest four revenues 1400+1500+1600+1700 = 6200; prior four
    // 1000+1100+1200+1300 = 4600. 6200/4600 − 1 = 0.3478...
    expect(metrics.revenueGrowth.value).toBeCloseTo(6_200 / 4_600 - 1, 10);
    expect(metrics.revenueGrowth.reliability).toBe("ok");
    expect(metrics.revenueGrowth.period).toBe(
      "TTM 2025-07-01..2026-06-30 vs TTM 2024-07-01..2025-06-30",
    );
  });

  it("marks non-USD growth FX-unadjusted and says why", () => {
    const metrics = derive(syntheticStatements(eightGoodQuarters()));
    expect(metrics.revenueGrowth.fxUnadjusted).toBe(true);
    expect(metrics.revenueGrowth.note).toMatch(/FX effects not isolated/);
    expect(metrics.earningsGrowth.fxUnadjusted).toBe(true);
  });

  it("averages equity across the window for return on equity", () => {
    const metrics = derive(syntheticStatements(eightGoodQuarters()));
    // Net income 140+150+160+170 = 620; equity 2400,2500,2600,2700 avg 2550.
    expect(metrics.roe.value).toBeCloseTo(620 / 2_550, 10);
    expect(metrics.roe.period).toContain("average equity across the four quarters");
  });
});

describe("basis pinning", () => {
  it("refuses to sum a window whose quarters are on different bases", () => {
    const quarters = eightGoodQuarters();
    // One standalone quarter inside the latest trailing window.
    quarters[6] = { ...quarters[6], basis: "standalone" };
    const metrics = derive(syntheticStatements(quarters));

    expect(metrics.revenue.reliability).toBe("missing");
    expect(metrics.revenue.value).toBeNull();
    expect(metrics.revenue.note).toMatch(/mixed reporting basis/);
    expect(metrics.netMargin.reliability).toBe("missing");
    expect(metrics.revenueGrowth.reliability).toBe("missing");
  });

  it("refuses when the current and prior windows are each clean but disagree", () => {
    const quarters = eightGoodQuarters().map((q, i) =>
      i < 4 ? { ...q, basis: "standalone" as const } : q,
    );
    const metrics = derive(syntheticStatements(quarters));
    // Each window is internally consistent, so the per-window TTM figures
    // stand; the GROWTH comparison across them does not.
    expect(metrics.revenue.reliability).toBe("ok");
    expect(metrics.revenueGrowth.reliability).toBe("missing");
    expect(metrics.revenueGrowth.note).toMatch(/mixed reporting basis/);
  });

  it("carries the basis through onto every derived metric", () => {
    const metrics = derive(syntheticStatements(eightGoodQuarters()));
    expect(metrics.revenue.basis).toBe("consolidated");
    expect(metrics.netMargin.basis).toBe("consolidated");
    expect(metrics.fcf.basis).toBe("consolidated");
  });
});

describe("consolidated and standalone differing materially", () => {
  it("never blends the two into one trailing figure", () => {
    // Standalone revenue roughly half of consolidated — the shape of a
    // holding company whose subsidiaries carry most of the business.
    const quarters = eightGoodQuarters().map((q, i) =>
      i % 2 === 0
        ? { ...q, basis: "standalone" as const, revenue: (q.revenue as number) / 2 }
        : q,
    );
    const metrics = derive(syntheticStatements(quarters));
    expect(metrics.revenue.reliability).toBe("missing");
    // The blended figure that must never be produced.
    expect(metrics.revenue.value).not.toBe(6_200 - 1_400 / 2 - 1_600 / 2);
  });
});

describe("fewer than eight quarters", () => {
  it("computes trailing metrics from four but marks growth missing", () => {
    const metrics = derive(syntheticStatements(eightGoodQuarters().slice(-4)));
    expect(metrics.revenue.reliability).toBe("ok");
    expect(metrics.netMargin.reliability).toBe("ok");
    expect(metrics.revenueGrowth.reliability).toBe("missing");
    expect(metrics.earningsGrowth.reliability).toBe("missing");
  });

  it("marks everything trailing missing below four quarters", () => {
    const metrics = derive(syntheticStatements(eightGoodQuarters().slice(-3)));
    for (const key of ["revenue", "netIncome", "netMargin", "fcf", "roe"] as const) {
      expect(metrics[key].reliability, key).toBe("missing");
      expect(metrics[key].value, key).toBeNull();
    }
  });

  it("refuses to sum four quarters that are not contiguous", () => {
    // A provider that silently omits a quarter would otherwise hand back four
    // rows spanning fifteen months, summed and labelled "trailing twelve".
    const quarters = eightGoodQuarters().filter((q) => q.periodEnd !== "2025-12-31");
    const metrics = derive(syntheticStatements(quarters.slice(-4)));
    expect(metrics.revenue.reliability).toBe("missing");
  });
});

describe("corporate actions", () => {
  const doubled = () =>
    eightGoodQuarters((i) => (i >= 4 ? { dilutedShares: 2_000 } : { dilutedShares: 1_000 }));

  it("skips the share-count rule when a bonus issue explains the jump", () => {
    const statements = syntheticStatements(doubled(), {
      corporateActions: [{ kind: "bonus", date: "2025-08-01", ratio: 2 }],
    });
    const metrics = deriveMetrics({ statements, profile: NSE_PROFILE });
    const gate = runPlausibilityGate({ metrics, statements, profile: NSE_PROFILE, now: FIXED_NOW });

    expect(gate.metrics.dilutedShares.reliability).toBe("ok");
    expect(gate.findings.map((f) => f.rule)).not.toContain("share_count_yoy");
  });

  it("flags the jump when a feed was checked and found nothing", () => {
    const statements = syntheticStatements(doubled(), { corporateActions: [] });
    const metrics = deriveMetrics({ statements, profile: NSE_PROFILE });
    const gate = runPlausibilityGate({ metrics, statements, profile: NSE_PROFILE, now: FIXED_NOW });

    expect(gate.metrics.dilutedShares.reliability).toBe("unreliable");
    expect(gate.findings.map((f) => f.rule)).toContain("share_count_yoy");
  });

  it("marks the count unreliable — never ok — when no feed was available", () => {
    // "We could not check" is not "it is fine".
    const statements = syntheticStatements(doubled(), { corporateActions: null });
    const metrics = deriveMetrics({ statements, profile: NSE_PROFILE });
    const gate = runPlausibilityGate({ metrics, statements, profile: NSE_PROFILE, now: FIXED_NOW });

    expect(gate.metrics.dilutedShares.reliability).toBe("unreliable");
    expect(gate.findings.map((f) => f.rule)).toContain("share_count_yoy_unverifiable");
  });
});

describe("loss-makers and non-payers", () => {
  it("declines a growth rate across a sign change instead of reporting one", () => {
    const quarters = eightGoodQuarters((i) => (i < 4 ? { netIncome: -100 } : {}));
    const metrics = derive(syntheticStatements(quarters));
    expect(metrics.earningsGrowth.reliability).toBe("missing");
    expect(metrics.earningsGrowth.note).toMatch(/changed sign/);
  });

  it("declines a price/earnings multiple on negative trailing earnings", () => {
    const quarters = eightGoodQuarters(() => ({ netIncome: -50 }));
    const metrics = derive(syntheticStatements(quarters));
    expect(metrics.trailingPe.reliability).toBe("missing");
    expect(metrics.trailingPe.note).toMatch(/not positive/);
  });

  it("declines both payout bases for a non-payer rather than reporting zero", () => {
    const quarters = eightGoodQuarters(() => ({ dividendsPaid: null }));
    const metrics = derive(syntheticStatements(quarters));
    expect(metrics.payoutRatioCash.reliability).toBe("missing");
    expect(metrics.payoutRatioDeclared.reliability).toBe("missing");
  });
});

describe("revenue line", () => {
  it("never lets other income into revenue or the margins", () => {
    // An Ind AS filer's total income exceeds revenue from operations. Margins
    // must be built on the operating line: TCS Q1 FY27 is 72,275 cr of
    // revenue against 73,843 cr of total income, a 2.2% gap.
    const quarters = eightGoodQuarters((i) => ({
      revenue: 1_000 + i * 100,
      totalIncome: 1_022 + i * 100,
      otherIncome: 22,
    }));
    const metrics = derive(syntheticStatements(quarters));
    expect(metrics.revenue.value).toBe(6_200);
    expect(metrics.netMargin.value).toBeCloseTo(620 / 6_200, 10);
  });
});

describe("fiscal-year labelling", () => {
  it("spells out the months for a March year end", () => {
    const statements = syntheticStatements(eightGoodQuarters(), {
      forward: [{ epsAvg: 10, periodEnd: "2027-03-31" }],
      spot: {
        ...syntheticStatements([]).spot,
        price: 100,
        mostRecentQuarter: "2026-06-30",
      },
    });
    const metrics = deriveMetrics({ statements, profile: NSE_PROFILE });
    expect(metrics.forwardPe.period).toBe(
      "consensus estimate for FY2027 (Apr 2026 – Mar 2027)",
    );
  });

  it("spells out the months for a January year end", () => {
    const usProfile = resolveReportingProfile({
      exchange: "NASDAQ",
      fiscalYearEndMonthFromFilings: 1,
      reportingCurrency: "USD",
    });
    const statements = syntheticStatements(eightGoodQuarters(), {
      forward: [{ epsAvg: 10, periodEnd: "2027-01-31" }],
      spot: { ...syntheticStatements([]).spot, price: 100, currency: "USD", financialCurrency: "USD" },
    });
    const metrics = deriveMetrics({ statements, profile: usProfile });
    expect(metrics.forwardPe.period).toBe(
      "consensus estimate for FY2027 (Feb 2026 – Jan 2027)",
    );
  });

  it("emits no multiple at all when the estimate has no fiscal year", () => {
    const statements = syntheticStatements(eightGoodQuarters(), {
      forward: [{ epsAvg: 10, periodEnd: null }],
    });
    const metrics = deriveMetrics({ statements, profile: NSE_PROFILE });
    expect(metrics.forwardPe.value).toBeNull();
    expect(metrics.forwardPe.reliability).toBe("missing");
  });
});
