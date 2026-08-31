/**
 * Provider-agnostic market-data contract. All automated-analysis code depends
 * on this interface, never on a specific provider's client or response shape,
 * so a future provider swap (or adding a second one) never touches watchlist,
 * chart generation, the AI pipeline, quota, the daily briefing job, or email.
 */

export type CandleUnit = "minutes" | "hours" | "days" | "weeks" | "months";

export interface Candle {
  timestamp: string; // ISO 8601, as returned by the provider
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  instrumentKey: string;
  lastPrice: number;
  asOf: string; // ISO 8601
}

export interface HistoricalCandlesParams {
  instrumentKey: string;
  unit: CandleUnit;
  interval: number;
  toDate: string; // YYYY-MM-DD
  fromDate?: string; // YYYY-MM-DD
}

/**
 * Reasons a market-data call can fail, kept narrow and explicit so callers
 * can decide policy (e.g. "log and skip this symbol") without needing to
 * inspect a provider-specific error shape.
 */
export type MarketDataErrorReason = "auth" | "not_found" | "provider_error";

export class MarketDataError extends Error {
  constructor(
    readonly reason: MarketDataErrorReason,
    message: string,
  ) {
    super(message);
  }
}

export interface MarketDataProvider {
  /** Real, already-settled candles only — must never fabricate or interpolate data. */
  getHistoricalCandles(params: HistoricalCandlesParams): Promise<Candle[]>;
  getQuote(instrumentKey: string): Promise<Quote>;
}
