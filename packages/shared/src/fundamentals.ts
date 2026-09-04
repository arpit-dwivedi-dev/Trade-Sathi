/**
 * The fundamentals contract: what apps/api reads out of the market-data
 * provider and what apps/web's Fundamentals tab renders back.
 *
 * Every figure is `number | null` rather than optional. The upstream source is
 * sparse in a way that varies by company and by market — a bank has no gross
 * margin, a loss-making company has no trailing P/E, a non-payer has no
 * dividend yield — so "absent" is a normal reading the UI has to draw, not an
 * error. A null therefore means "not reported for this instrument", and the
 * screen shows a dash for it.
 *
 * Ratios that are conceptually percentages (margins, growth, yields) are kept
 * as fractions here (0.184, not 18.4) and formatted at the edge.
 */

/** Where the numbers came from and what currency they are quoted in. */
export interface FundamentalsMeta {
  /** Currency of the price snapshot, e.g. "INR". */
  currency: string | null;
  /**
   * Currency the financial statements are reported in. Usually the same as
   * `currency`, but not always for a cross-listed company.
   */
  financialCurrency: string | null;
  /** When the price snapshot was taken, ISO 8601. */
  asOf: string | null;
  /** End of the most recently reported quarter, YYYY-MM-DD. */
  mostRecentQuarter: string | null;
}

/** Who the company is. Descriptive only — nothing here is a figure. */
export interface FundamentalsProfile {
  sector: string | null;
  industry: string | null;
  employees: number | null;
  website: string | null;
  summary: string | null;
}

/** Today's price and where it sits in its own recent range. */
export interface FundamentalsSnapshot {
  price: number | null;
  change: number | null;
  /** Fraction, e.g. -0.0123 for -1.23%. */
  changePercent: number | null;
  previousClose: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyDayAverage: number | null;
  twoHundredDayAverage: number | null;
  volume: number | null;
  averageVolume: number | null;
  marketCap: number | null;
}

/** What the market is paying for the company's earnings, assets and payout. */
export interface FundamentalsValuation {
  trailingPe: number | null;
  forwardPe: number | null;
  pegRatio: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  enterpriseValue: number | null;
  enterpriseToRevenue: number | null;
  enterpriseToEbitda: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
  bookValue: number | null;
  /** Fraction. */
  dividendYield: number | null;
  dividendRate: number | null;
  /** Fraction. */
  payoutRatio: number | null;
  beta: number | null;
}

/** Margins and returns, all fractions. */
export interface FundamentalsProfitability {
  grossMargin: number | null;
  operatingMargin: number | null;
  ebitdaMargin: number | null;
  profitMargin: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
}

/** Year-on-year growth of the most recent period, fractions. */
export interface FundamentalsGrowth {
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  earningsQuarterlyGrowth: number | null;
}

/** Scale and balance-sheet strength. */
export interface FundamentalsHealth {
  totalRevenue: number | null;
  ebitda: number | null;
  netIncome: number | null;
  totalCash: number | null;
  totalDebt: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  freeCashflow: number | null;
  operatingCashflow: number | null;
  sharesOutstanding: number | null;
}

/** One reported fiscal year, for the financial-history chart and table. */
export interface FundamentalsAnnualPeriod {
  /** Fiscal period end, YYYY-MM-DD. */
  asOfDate: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  dilutedEps: number | null;
}

/** Everything the Fundamentals tab draws for one instrument. */
export interface InstrumentFundamentals {
  instrument: {
    id: string;
    symbol: string;
    name: string;
    exchange: string;
  };
  meta: FundamentalsMeta;
  profile: FundamentalsProfile;
  snapshot: FundamentalsSnapshot;
  valuation: FundamentalsValuation;
  profitability: FundamentalsProfitability;
  growth: FundamentalsGrowth;
  health: FundamentalsHealth;
  /** Oldest fiscal year first. Empty when the provider reports no history. */
  annual: FundamentalsAnnualPeriod[];
}
