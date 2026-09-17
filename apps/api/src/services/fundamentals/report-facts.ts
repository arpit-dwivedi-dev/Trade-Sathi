import type {
  DerivedFacts,
  DerivedMetrics,
  Metric,
  ReportThresholds,
} from "@tradesathi/shared";

/**
 * The verdicts the model is GIVEN rather than asked to derive.
 *
 * Leverage banding, whether growth supports earnings, dividend
 * sustainability and the valuation read are all fixed rules over named
 * numbers. Letting a language model reach them produced a steady trickle of
 * contradictions that then had to be undone by post-hoc reconcilers reading
 * its output — a correction loop that only existed because the model was
 * allowed to derive things it shouldn't have. Computing them here deletes
 * both the errors and the loop.
 */

/** Only an 'ok' metric may drive a verdict. Unreliable or missing is not evidence. */
function usable(metric: Metric): number | null {
  return metric.reliability === "ok" ? metric.value : null;
}

/**
 * One threshold set per report, defined once here and reused by the verdict,
 * the scenarios and the falsifiers.
 *
 * Every threshold is ANCHORED to the company's own current value, so a
 * scenario cannot name a bare invented number. Previously each section
 * invented its own: we shipped 25% and 30% for the same NVDA condition, and
 * 10%, 12% and 13.9% for the same TCS one, inside a single report.
 */
export function buildThresholds(metrics: DerivedMetrics): ReportThresholds {
  const operatingMargin = usable(metrics.operatingMargin);
  const revenueGrowth = usable(metrics.revenueGrowth) ?? usable(metrics.revenueGrowthFy);
  const fcf = usable(metrics.fcf);
  const netIncome = usable(metrics.netIncome);
  const equity = usable(metrics.equity);
  const totalDebt = usable(metrics.totalDebt);

  return {
    // Three points below where the company actually runs today.
    operatingMarginFloor: operatingMargin === null ? 0 : round4(operatingMargin - 0.03),
    // Half of current growth, floored at zero — "growth halving" is a
    // condition a reader can check, unlike a number with no relationship to
    // what the company reports.
    revenueGrowthFloor: revenueGrowth === null ? 0 : round4(Math.max(0, revenueGrowth / 2)),
    // Cash conversion holding at four fifths of where it is today.
    cashConversionFloor:
      fcf === null || netIncome === null || netIncome <= 0
        ? 0.8
        : round4(Math.max(0, (fcf / netIncome) * 0.8)),
    // Gross debt to equity, one step above the current band.
    leverageCeiling:
      equity === null || equity <= 0 || totalDebt === null
        ? 1
        : round4(Math.max(0.25, (totalDebt / equity) * 2)),
  };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Gross leverage, banded on debt to equity computed from the two filed
 * balance-sheet lines.
 *
 * Deliberately gross, never adjusted for net cash. A net-cash position is
 * real and worth stating, but it is a different concept from gross
 * indebtedness — conflating them is how a company with real positive debt
 * ended up labelled "zero" leverage in production.
 */
function leverageBand(metrics: DerivedMetrics): DerivedFacts["leverageBand"] {
  const totalDebt = usable(metrics.totalDebt);
  const equity = usable(metrics.equity);
  if (totalDebt === 0) return "zero";
  if (totalDebt === null || equity === null || equity <= 0) return "unk";
  const ratio = totalDebt / equity;
  if (ratio === 0) return "zero";
  if (ratio < 0.5) return "low";
  if (ratio <= 1) return "moderate";
  return "high";
}

/**
 * Whether earnings growth keeps up with revenue growth.
 *
 * Trailing figures are used when available; otherwise the fiscal-year pair,
 * which is a real comparison on its own terms. The two are never mixed — a
 * trailing revenue growth against a fiscal-year earnings growth is precisely
 * the period mix this rebuild exists to stop.
 */
function growthSupportsEarnings(
  metrics: DerivedMetrics,
): DerivedFacts["growthSupportsEarnings"] {
  const pairs: [number | null, number | null][] = [
    [usable(metrics.revenueGrowth), usable(metrics.earningsGrowth)],
    [usable(metrics.revenueGrowthFy), usable(metrics.earningsGrowthFy)],
  ];
  const pair = pairs.find(([r, e]) => r !== null && e !== null);
  if (!pair) return "unk";
  const [revenue, earnings] = pair as [number, number];

  if (earnings < 0 && revenue > 0) return "no";
  if (earnings < revenue - 0.05) return "no";
  if (revenue > 0 && earnings >= revenue) return "yes";
  return "mixed";
}

/**
 * Dividend sustainability, judged on BOTH payout bases.
 *
 * The cash basis and the declared basis routinely differ — Indian final
 * dividends are declared after the year closes and paid in the next one — and
 * that gap is expected, not a conflict. The verdict is taken on the more
 * demanding of the two rather than downgraded to "unk" because they disagree,
 * which is what the old rule did to both TCS and NVDA.
 */
function dividendSustainability(
  metrics: DerivedMetrics,
): DerivedFacts["dividendSustainability"] {
  const cash = usable(metrics.payoutRatioCash);
  const declared = usable(metrics.payoutRatioDeclared);
  const ratios = [cash, declared].filter((r): r is number => r !== null);
  if (ratios.length === 0) return "unk";

  // A company paying nothing on either basis is a non-payer, which is
  // reported data rather than a gap in it.
  if (ratios.every((r) => r === 0)) return "none";

  const worst = Math.max(...ratios);
  const fcf = usable(metrics.fcf);
  const dividendsPaid = usable(metrics.dividendsPaid);
  const coveredByFreeCashFlow =
    fcf !== null && dividendsPaid !== null && dividendsPaid > 0 && fcf >= dividendsPaid;

  if (worst > 0.8 && !coveredByFreeCashFlow) return "aggressive";
  if (worst <= 0.6) return "conservative";
  if (worst <= 0.8 || coveredByFreeCashFlow) return "conservative";
  return "aggressive";
}

/**
 * What the trailing multiple is consistent with, given the evidenced growth.
 *
 * Business quality is NOT valuation evidence. A high return on equity, a
 * stable margin or a net-cash balance sheet says what kind of business this
 * is; it says nothing about whether the price paid for it is reasonable. Only
 * a growth trajectory can support a multiple, so with no growth evidence the
 * answer is "unk" rather than a quality-flattered "supported".
 */
function valuationRead(metrics: DerivedMetrics): DerivedFacts["valuationRead"] {
  const pe = usable(metrics.trailingPe);
  const growth = usable(metrics.revenueGrowth) ?? usable(metrics.revenueGrowthFy);
  if (pe === null || growth === null) return "unk";

  // The multiple read against growth, on one consistent rule.
  if (growth <= 0) return pe > 15 ? "stretched" : "compressed";
  const impliedYears = pe / (growth * 100);
  if (impliedYears > 2.5) return "stretched";
  if (impliedYears < 1) return "compressed";
  return "supported";
}

export function buildFacts(metrics: DerivedMetrics): DerivedFacts {
  const fcf = usable(metrics.fcf);
  const netIncome = usable(metrics.netIncome);

  return {
    leverageBand: leverageBand(metrics),
    growthSupportsEarnings: growthSupportsEarnings(metrics),
    dividendSustainability: dividendSustainability(metrics),
    valuationRead: valuationRead(metrics),
    // Cash conversion deliberately null when the two inputs sit on different
    // trailing windows would be over-strict; the metrics' own period labels
    // carry that, and the prompt is told to name both.
    cashConversion:
      fcf === null || netIncome === null || netIncome <= 0 ? null : round4(fcf / netIncome),
    thresholds: buildThresholds(metrics),
  };
}
