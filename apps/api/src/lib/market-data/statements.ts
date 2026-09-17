import type { ReportingBasis } from "@tradesathi/shared";

/** Which upstream produced a period's figures. See statements-merge.ts. */
export type StatementSource = "yahoo" | "sec-edgar" | "nse-bse";

/**
 * Provider-agnostic RAW financial statements.
 *
 * This is the only fundamentals input the derivation layer accepts. It carries
 * reported statement lines and nothing else — no growth rate, no margin, no
 * free-cash-flow field, no payout ratio. Those are computed downstream from
 * these numbers, because the provider's versions of them are mixed-period and
 * mixed-basis and cannot be labelled correctly.
 *
 * Every figure is in whole reporting-currency units, exactly as filed, and
 * every period carries the date it ends on and the basis it was filed under.
 */

/** One reported period — a fiscal quarter or a fiscal year. */
export interface RawPeriod {
  /** Period end, YYYY-MM-DD. */
  periodEnd: string;
  /** 3 for a quarter, 12 for a full year. */
  months: 3 | 12;
  basis: ReportingBasis;
  currency: string | null;

  /** Which upstream produced this period's figures. */
  source: StatementSource;
  /**
   * Date the filing was made/accepted, YYYY-MM-DD, or null when the source
   * does not state one (Yahoo never does).
   */
  filingDate: string | null;

  // --- Income statement ---
  /**
   * The revenue line the ReportingProfile names: revenue from operations for
   * an Ind AS filer, total revenue for a US GAAP one. NEVER total income.
   */
  revenue: number | null;
  /** Revenue + other income, where the filer reports it separately. */
  totalIncome: number | null;
  /** Reported separately and excluded from revenue, growth and every margin. */
  otherIncome: number | null;
  costOfRevenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  pretaxIncome: number | null;
  /** Attributable to common shareholders. */
  netIncome: number | null;
  dilutedShares: number | null;

  // --- Cash flow statement ---
  operatingCashFlow: number | null;
  /**
   * Purchases of property, plant and equipment, as a POSITIVE magnitude.
   * Providers report this as a negative outflow; it is normalised on the way
   * in so no downstream sign convention has to be remembered.
   */
  capex: number | null;
  /** Dividends actually paid in the period, as a positive magnitude. */
  dividendsPaid: number | null;

  // --- Balance sheet ---
  equity: number | null;
  totalDebt: number | null;
  cash: number | null;
  sharesOutstanding: number | null;

  /**
   * True when this period was reconstructed as (fiscal year − the other
   * reported quarters of that year) rather than read directly. The
   * arithmetic is exact and was validated against the provider's own later
   * publication of the same quarter, but a reconstructed period is still
   * recorded so the trace can show it.
   */
  reconstructed?: boolean;

  /**
   * Sources that supplied lines this period's own source does not report —
   * an official filing completed with the vendor's balance sheet and cash
   * flow, say. Present only when such a fill actually happened, and only
   * ever after the two series were proved to be the same one. See
   * statements-merge.ts.
   */
  completedFrom?: StatementSource[];
}

/** Point-in-time market data — the only non-statement input. */
export interface RawSpot {
  price: number | null;
  /** ISO 8601 timestamp of the price. */
  asOf: string | null;
  marketCap: number | null;
  /** Price/market currency, which is not always the statement currency. */
  currency: string | null;
  /** Statement reporting currency. */
  financialCurrency: string | null;
  /** Dividend per share declared over the trailing twelve months. */
  dividendDeclaredPerShare: number | null;
  /**
   * The provider's own quoted dividend yield, as a fraction. Carried ONLY so
   * the plausibility gate can check it against the declared dividend per
   * share at the quoted price — two point-in-time market fields that must
   * agree with each other. It is never used to derive a payout ratio.
   */
  dividendYield: number | null;
  /** Most recent reported quarter end, YYYY-MM-DD. */
  mostRecentQuarter: string | null;
}

/** A forward consensus estimate, with the fiscal year it applies to. */
export interface RawForwardEstimate {
  epsAvg: number | null;
  /** Fiscal period end the estimate applies to, YYYY-MM-DD. Without this the
   *  estimate is unusable: a bare "forward P/E" is never emitted. */
  periodEnd: string | null;
}

/** A corporate action falling inside the derivation window. */
export interface RawCorporateAction {
  kind: "split" | "bonus" | "buyback";
  /** Effective date, YYYY-MM-DD. */
  date: string;
  /** New shares per old share, e.g. 2 for a 1:1 bonus. Null when unknown. */
  ratio: number | null;
}

export interface RawStatements {
  /** Fiscal quarters, oldest first. */
  quarterly: RawPeriod[];
  /** Fiscal years, oldest first. */
  annual: RawPeriod[];
  spot: RawSpot;
  /** Forward estimates keyed by nothing — the fiscal year lives on each. */
  forward: RawForwardEstimate[];
  /**
   * Corporate actions in the window, or null when NO FEED WAS AVAILABLE.
   * Null and [] mean different things: [] is "checked, none found", null is
   * "could not check", and the share-count plausibility rule treats the
   * latter as 'unreliable' rather than 'ok'.
   */
  corporateActions: RawCorporateAction[] | null;
}
