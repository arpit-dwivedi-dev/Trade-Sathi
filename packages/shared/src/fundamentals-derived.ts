/**
 * The derived-fundamentals contract.
 *
 * Everything here is computed by apps/api from period-stamped RAW financial
 * statements. Nothing in this file is ever populated from a provider's
 * pre-computed convenience field.
 *
 * WHY THIS EXISTS
 *
 * The previous pipeline consumed the provider's own ratio fields
 * (revenueGrowth, operatingMargins, freeCashflow, payoutRatio, ...) and
 * labelled the result "TTM". Those fields are mixed-period and mixed-basis:
 * verified against filings, a reported "13.9% revenue growth / 4.6% earnings
 * growth / 24.0% operating margin" for TCS was three *quarterly* Q1 FY27
 * values wearing a TTM label, and the report's entire "earnings lag revenue"
 * thesis was an artefact of that mislabel. The provider's free-cash-flow
 * field additionally subtracts acquisitions and securities purchases, which
 * is how a fabless company (NVDA) came out with $92B of implied capex.
 *
 * The raw statements themselves matched the filings exactly. So: raw
 * statements are trusted, derived metrics are computed here, and every value
 * carries the period it belongs to.
 */

/**
 * How a filer reports, expressed as PROPERTIES rather than as a country.
 *
 * "India" is not the real variable. Fiscal-year-end month, which line counts
 * as revenue, and whether consolidated and standalone are both filed are the
 * real variables — and each of them recurs outside India. Branching on the
 * property keeps the rules honest when the next market arrives.
 */
export interface ReportingProfile {
  exchange: 'NSE' | 'BSE' | 'NASDAQ' | 'NYSE';
  /** 1-12. Read from the filing, never assumed — NVDA's is 1, not 12. */
  fiscalYearEndMonth: number;
  /**
   * Ind AS filers report "revenue from operations" separately from "total
   * income" (which folds in other income). TCS Q1 FY27 is 72,275 cr of
   * revenue against 73,843 cr of total income — a 2.2% gap that silently
   * corrupts growth and every margin if the two are ever mixed.
   */
  revenueLine: 'revenue_from_operations' | 'total_revenue';
  basisAvailable: ('consolidated' | 'standalone')[];
  preferredBasis: 'consolidated';
  reportingCurrency: string;
  displayUnit: 'crore' | 'billion';
  /**
   * True where the fourth quarter is published as the balancing figure
   * between the audited full year and the three reported quarters, so
   * year-end adjustments concentrate in it.
   */
  q4IsBalancingFigure: boolean;
  corporateActions: ('split' | 'bonus' | 'buyback')[];
  /** Exchange calendar code, used for price staleness. */
  marketCalendar: string;
}

/** Where a metric's reliability landed. There is deliberately no
 *  'corrected' state — see the plausibility gate. */
export type MetricReliability = 'ok' | 'unreliable' | 'missing';

export type ReportingBasis = 'consolidated' | 'standalone' | 'unknown';

/**
 * One derived figure and everything needed to read it correctly.
 *
 * `period` is not optional decoration. A metric without a period is the exact
 * defect this module exists to remove: a right number with a wrong period
 * label is still a wrong report.
 */
export interface Metric {
  value: number | null;
  /**
   * e.g. "TTM 2025-07-27..2026-07-26", "FY2026 (Apr 2025 – Mar 2026)",
   * "MRQ 2026-06-30", "spot".
   */
  period: string;
  basis: ReportingBasis;
  currency: string;
  /** The raw statement lines this was computed from, for the debug trace. */
  derivedFrom: string[];
  reliability: MetricReliability;
  /** Growth stated in a non-USD reporting currency, with FX not isolated. */
  fxUnadjusted?: boolean;
  note?: string;
}

/**
 * A plain-English note about the data, written for the reader of the report.
 * Never a field path, never a raw float — we shipped `0.38509998` to a user.
 */
export interface DataNote {
  /** Short label, e.g. "Growth comparison unavailable". */
  title: string;
  /** One or two sentences a non-technical reader can act on. */
  detail: string;
  severity: 'info' | 'caution';
}

/** The machine-readable trace behind a DataNote, kept for the debug toggle. */
export interface PlausibilityFinding {
  /** The metric key this concerns. */
  metric: string;
  /** The rule that fired, e.g. "capex_over_revenue". */
  rule: string;
  detail: string;
}

/** Every metric the report is allowed to reason about. */
export interface DerivedMetrics {
  // Scale, TTM
  revenue: Metric;
  netIncome: Metric;
  grossProfit: Metric;
  operatingIncome: Metric;
  pretaxIncome: Metric;

  // Growth
  revenueGrowth: Metric;
  earningsGrowth: Metric;
  /**
   * Fiscal-year-over-fiscal-year growth, from the audited annual statements.
   *
   * A DIFFERENT measure from revenueGrowth/earningsGrowth above, not a
   * fallback for them, and never to be described as trailing. It exists
   * because the provider caps quarterly history below the eight quarters a
   * trailing comparison needs, and a report with no growth evidence at all
   * is less useful than one with correctly-labelled annual growth.
   */
  revenueGrowthFy: Metric;
  earningsGrowthFy: Metric;

  // Margins, all TTM
  grossMargin: Metric;
  operatingMargin: Metric;
  netMargin: Metric;

  // Cash
  operatingCashFlow: Metric;
  /** Dividends actually paid over the trailing window. */
  dividendsPaid: Metric;
  capex: Metric;
  /** OCF − capex. Nothing else is ever subtracted. */
  fcf: Metric;

  // Returns
  roe: Metric;

  // Balance sheet, MRQ
  totalDebt: Metric;
  totalCash: Metric;
  netCash: Metric;
  equity: Metric;

  // Per share / market
  price: Metric;
  dilutedShares: Metric;
  trailingEps: Metric;
  trailingPe: Metric;
  /** Only ever emitted with the estimate's fiscal year named in `period`. */
  forwardPe: Metric;
  marketCap: Metric;

  // Dividends — two bases, both labelled, a gap between them is expected
  payoutRatioCash: Metric;
  payoutRatioDeclared: Metric;

  // Diagnostics
  impliedTaxRate: Metric;
}

export type DerivedMetricKey = keyof DerivedMetrics;

/** A pre-computed verdict handed to the prompt. The model does not derive
 *  these; it explains them. */
export interface DerivedFacts {
  leverageBand: 'zero' | 'low' | 'moderate' | 'high' | 'unk';
  growthSupportsEarnings: 'yes' | 'no' | 'mixed' | 'unk';
  dividendSustainability: 'conservative' | 'aggressive' | 'none' | 'unk';
  valuationRead: 'supported' | 'stretched' | 'compressed' | 'unk';
  cashConversion: number | null;
  /** One threshold set per report, defined once and reused across the
   *  verdict, the scenarios and the falsifiers. */
  thresholds: ReportThresholds;
}

/**
 * The single source of numeric thresholds for one report.
 *
 * Defined once and reused everywhere. Previously the verdict, the scenarios
 * and the falsifiers each invented their own: we shipped 25% and 30% for the
 * same NVDA condition, and 10% / 12% / 13.9% for the same TCS one.
 */
export interface ReportThresholds {
  /** Operating margin floor the report reasons against, as a fraction. */
  operatingMarginFloor: number;
  /** Revenue growth floor, as a fraction. */
  revenueGrowthFloor: number;
  /** Cash conversion (FCF ÷ net income) floor. */
  cashConversionFloor: number;
  /** Net-debt-to-equity ceiling, as a fraction. */
  leverageCeiling: number;
}

/**
 * One audited fiscal year, for multi-year trend reading only.
 *
 * Deliberately a handful of headline lines and not a full RawPeriod: this
 * exists so a report can say whether growth is accelerating or where an
 * earlier trough sat, not to be re-derived from. Every trailing figure still
 * comes from the metrics, which carry their own periods and reliability.
 */
export interface AnnualHistoryEntry {
  /** Fiscal year end, YYYY-MM-DD. */
  periodEnd: string;
  /** Carried so a consumer can never compare a consolidated year to a standalone one. */
  basis: ReportingBasis;
  revenue: number | null;
  netIncome: number | null;
  operatingIncome: number | null;
  operatingCashFlow: number | null;
}

/** Everything the derivation layer hands downstream. */
export interface DerivedFundamentals {
  profile: ReportingProfile;
  metrics: DerivedMetrics;
  facts: DerivedFacts;
  /**
   * The most recent audited fiscal years, oldest first, capped at five.
   * Empty when the sources supply no annual statements.
   */
  annualHistory: AnnualHistoryEntry[];
  /** User-facing "Data notes". */
  dataNotes: DataNote[];
  /** Machine trace behind the notes, for the debug toggle. */
  findings: PlausibilityFinding[];
  /** Quarters actually used, oldest first, for the trace. */
  quartersUsed: string[];
}
