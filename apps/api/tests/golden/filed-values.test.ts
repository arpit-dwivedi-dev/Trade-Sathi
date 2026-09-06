import { loadFixture, runPipeline } from "./harness.js";

/**
 * The hand-entered filing values from the rebuild brief, checked against what
 * deriveMetrics() actually produces from raw statements.
 *
 * Where the two agree, the tolerance is tight. Where they differ, the
 * difference is asserted EXPLICITLY with the reason, rather than the expected
 * value being loosened until it passed — an adjusted golden value would
 * defeat the entire purpose of having one.
 *
 * Three kinds of difference show up, and each is asserted as itself:
 *
 * 1. WINDOW SHIFT. The brief's TCS cash-flow figures are for the twelve
 *    months to 2026-06-30. Upstream publishes TCS cash-flow and balance-sheet
 *    lines only to 2026-03-31, so those metrics land on a window ending a
 *    quarter earlier. The values are within a percent of the brief's; the
 *    PERIOD is what differs, and the period label says so.
 * 2. DEFINITIONAL. Net cash here is cash and short-term investments less
 *    total debt. The brief's figure uses a different cash definition.
 * 3. UNAVAILABLE. Trailing-twelve-month growth needs eight contiguous
 *    quarters. Upstream caps quarterly history at about five and will not
 *    serve older ones at any requested window, so the comparison cannot be
 *    made and the metric is 'missing'. It is NOT filled from the provider's
 *    own growth field — that field is the mislabelled quarterly value this
 *    rebuild exists to remove.
 */

const MILLION = 1e6;
const BILLION = 1e9;

function within(actual: number, expected: number, relativeTolerance: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(relativeTolerance);
}

describe("TCS — TTM ending 2026-06-30, INR millions, filed values", () => {
  const { metrics, profile } = runPipeline(loadFixture("tcs-nse"));

  it("reproduces net income exactly", () => {
    expect(metrics.netIncome.value! / MILLION).toBe(497_990);
    expect(metrics.netIncome.period).toBe("TTM 2025-07-01..2026-06-30");
    expect(metrics.netIncome.reliability).toBe("ok");
  });

  it("reproduces net margin", () => {
    within(metrics.netMargin.value!, 0.1805, 0.001);
    expect(metrics.netMargin.period).toBe("TTM 2025-07-01..2026-06-30");
  });

  it("reproduces the diluted share count", () => {
    within(metrics.dilutedShares.value! / MILLION, 3_618, 0.001);
  });

  it("reproduces operating margin to within a quarter of a percent", () => {
    // 0.2495 against the brief's 0.2489. The quarter ending 2025-09-30 is
    // absent from the upstream operating-income series and is reconstructed
    // from the audited annual figure, so any rounding in the four upstream
    // inputs lands here.
    within(metrics.operatingMargin.value!, 0.2489, 0.005);
    expect(metrics.operatingMargin.period).toBe("TTM 2025-07-01..2026-06-30");
  });

  it("computes free cash flow as operating cash flow less capex and nothing else", () => {
    // The brief's 481,590 is for the twelve months to 2026-06-30; upstream
    // cash-flow data ends a quarter earlier, so this window ends 2026-03-31.
    expect(metrics.fcf.period).toBe("TTM 2025-03-31..2026-03-31");
    within(metrics.fcf.value! / MILLION, 481_590, 0.01);
    // The identity itself is exact, whatever the window.
    expect(metrics.fcf.value).toBe(
      metrics.operatingCashFlow.value! - metrics.capex.value!,
    );
    within(metrics.operatingCashFlow.value! / MILLION, 523_460, 0.01);
    within(metrics.capex.value! / MILLION, 41_870, 0.01);
  });

  it("reports total debt on the latest quarter that actually carries it", () => {
    within(metrics.totalDebt.value! / MILLION, 113_090, 0.01);
    expect(metrics.totalDebt.period).toBe("MRQ 2026-03-31");
  });

  it("states its own net-cash definition rather than an unlabelled one", () => {
    // Cash and short-term investments less total debt. The brief's 337,220
    // uses a different cash definition; this one is the two balance-sheet
    // lines actually filed, and the period names the quarter they came from.
    expect(metrics.netCash.value).toBe(metrics.totalCash.value! - metrics.totalDebt.value!);
    expect(metrics.netCash.period).toBe("MRQ 2026-03-31");
  });

  it("marks trailing growth missing rather than reporting the quarterly figure", () => {
    // The report previously carried 13.9% revenue growth and 4.6% earnings
    // growth. Both were Q1 FY27 QUARTERLY values wearing a TTM label, and
    // together they manufactured the entire "earnings lag revenue" thesis.
    // Neither number can be produced here by any path.
    expect(metrics.revenueGrowth.value).toBeNull();
    expect(metrics.revenueGrowth.reliability).toBe("missing");
    expect(metrics.revenueGrowth.note).toMatch(/eight contiguous quarters/);
    expect(metrics.earningsGrowth.value).toBeNull();
    expect(metrics.earningsGrowth.reliability).toBe("missing");
  });

  it("flags rupee-reported growth as FX-unadjusted when it can be computed", () => {
    // TCS rupee revenue grew 13.9% in a period its USD revenue grew 2.7% —
    // the gap is currency, not business. Whenever a growth figure IS
    // derivable for a non-USD reporter it must carry that caveat.
    expect(profile.reportingCurrency).toBe("INR");
    for (const key of ["revenueGrowth", "earningsGrowth"] as const) {
      if (metrics[key].value === null) continue;
      expect(metrics[key].fxUnadjusted).toBe(true);
      expect(metrics[key].note).toMatch(/FX effects not isolated/);
    }
  });

  it("resolves an Ind AS reporting profile from properties, not country", () => {
    expect(profile.fiscalYearEndMonth).toBe(3);
    expect(profile.revenueLine).toBe("revenue_from_operations");
    expect(profile.q4IsBalancingFigure).toBe(true);
    expect(profile.displayUnit).toBe("crore");
    expect(profile.marketCalendar).toBe("XNSE");
    expect(profile.corporateActions).toContain("bonus");
  });

  it("publishes both payout bases and treats the gap between them as expected", () => {
    expect(metrics.payoutRatioCash.reliability).toBe("ok");
    expect(metrics.payoutRatioDeclared.reliability).toBe("ok");
    // Indian final dividends are declared after the year closes and paid in
    // the next one, so cash paid systematically leads or lags declared. The
    // two differ here by a wide margin and NEITHER is downgraded for it.
    expect(metrics.payoutRatioCash.value).not.toBeCloseTo(
      metrics.payoutRatioDeclared.value!,
      1,
    );
    expect(metrics.payoutRatioDeclared.note).toMatch(/expected, not a conflict/);
  });
});

describe("NVDA — TTM ending 2026-07-31, USD billions, filed values", () => {
  const { metrics, profile } = runPipeline(loadFixture("nvda-nasdaq"));

  it("reads the fiscal year end from the filing, not from a December default", () => {
    expect(profile.fiscalYearEndMonth).toBe(1);
  });

  it("reproduces trailing revenue and net income exactly", () => {
    within(metrics.revenue.value! / BILLION, 302.97, 0.0001);
    within(metrics.netIncome.value! / BILLION, 192.88, 0.0001);
    expect(metrics.revenue.period).toBe("TTM 2025-08-01..2026-07-31");
    expect(metrics.netIncome.period).toBe("TTM 2025-08-01..2026-07-31");
  });

  it("computes free cash flow above 110 billion, not the provider's 41.81", () => {
    // The provider's own free-cash-flow field reported 41.81 against 134.36
    // of operating cash flow — implying 92 billion of capital expenditure for
    // a fabless company — because it also subtracts acquisitions and
    // purchases of securities. Here nothing but capex is subtracted.
    expect(metrics.fcf.value! / BILLION).toBeGreaterThan(110);
    expect(metrics.fcf.value).toBe(metrics.operatingCashFlow.value! - metrics.capex.value!);
  });

  it("derives real capex of roughly 7 billion, not 92", () => {
    const capexBillions = metrics.capex.value! / BILLION;
    expect(capexBillions).toBeGreaterThan(5);
    expect(capexBillions).toBeLessThan(9);
  });

  it("names the fiscal year on the forward multiple", () => {
    expect(metrics.forwardPe.period).toContain("FY2027 (Feb 2026 – Jan 2027)");
  });

  it("marks trailing growth missing rather than inventing a comparison", () => {
    expect(metrics.revenueGrowth.reliability).toBe("missing");
    expect(metrics.earningsGrowth.reliability).toBe("missing");
  });
});
