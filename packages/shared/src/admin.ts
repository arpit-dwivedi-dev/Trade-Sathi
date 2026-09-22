// The Admin panel contract: what apps/api's /api/admin/* endpoints return and
// apps/web's Admin tab renders. Read-only reporting shapes only.
//
// Money is integer minor units everywhere, and always keyed by currency: a
// `MoneyByCurrency` is never summed across its keys. AI cost is USD (the unit
// analyses.cost_usd is recorded in); there is no FX rate in this app, so P&L
// is only computed where revenue is also USD — see AdminEconomicsTotals.

export type AdminRange = '7d' | '30d' | 'all';

export const ADMIN_RANGES: readonly AdminRange[] = ['7d', '30d', 'all'];

/** Minor units keyed by ISO currency code, e.g. { INR: 90000, USD: 1200 }. */
export type MoneyByCurrency = Record<string, number>;

export interface AdminPage<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Estimated analysis economics for a set of analyses.
 *
 * revenue is credits consumed x the account's regional price per credit, so it
 * is an estimate of what the usage was worth, not cash received (that is
 * AdminPaymentSummary.revenue). estimatedPnlUsd is USD revenue minus the AI
 * cost of those same USD-priced analyses; INR-priced analyses have no P&L
 * figure because there is no configured exchange rate to convert their USD
 * cost with — their revenue and cost are reported side by side instead.
 */
export interface AdminEconomicsTotals {
  analyses: number;
  credits: number;
  revenue: MoneyByCurrency;
  aiCostUsd: number;
  /** AI cost broken down by the currency the analysis was priced in. */
  aiCostUsdByCurrency: Record<string, number>;
  estimatedPnlUsd: number | null;
  avgCostUsd: number | null;
  /** Average estimated revenue per analysis, per currency. */
  avgRevenue: MoneyByCurrency;
}

export interface AdminBreakdownRow extends AdminEconomicsTotals {
  key: string;
}

export interface AdminDailyPoint {
  day: string;
  analyses: number;
  failed: number;
  aiCostUsd: number;
  revenue: MoneyByCurrency;
}

export interface AdminPaymentSummary {
  /** Captured AND signature-verified payments only. */
  revenue: MoneyByCurrency;
  capturedCount: number;
  refunded: MoneyByCurrency;
  refundedCount: number;
  failedCount: number;
  createdCount: number;
  totalCount: number;
}

export interface AdminPaymentDailyPoint {
  day: string;
  revenue: MoneyByCurrency;
}

export interface AdminOverview {
  range: AdminRange;
  /** online: seen within the last few minutes (the web app heartbeats while a tab is open). */
  users: { total: number; new: number; active: number; paying: number; online: number };
  payments: AdminPaymentSummary;
  economics: AdminEconomicsTotals;
  failedAnalyses: number;
  analysisTrend: AdminDailyPoint[];
  revenueTrend: AdminPaymentDailyPoint[];
  locations: AdminLocationCount[];
  fx: AdminFx;
}

export interface AdminAnalysisRow {
  id: string;
  profileId: string;
  email: string;
  source: string;
  modelId: string;
  status: string;
  credits: number;
  revenueMinor: number;
  currency: string | null;
  costUsd: number | null;
  /** Null when the analysis was not priced in USD — see AdminEconomicsTotals. */
  estimatedPnlUsd: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AdminEconomicsFilters {
  sources: string[];
  models: string[];
  statuses: string[];
}

export interface AdminEconomics {
  totals: AdminEconomicsTotals;
  bySource: AdminBreakdownRow[];
  byModel: AdminBreakdownRow[];
  filters: AdminEconomicsFilters;
  page: AdminPage<AdminAnalysisRow>;
  fx: AdminFx;
}

export interface AdminPaymentRow {
  id: string;
  profileId: string;
  email: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  signatureVerified: boolean;
  creditsPurchased: number;
  createdAt: string;
  capturedAt: string | null;
}

export interface AdminPayments {
  summary: AdminPaymentSummary;
  trend: AdminPaymentDailyPoint[];
  page: AdminPage<AdminPaymentRow>;
}

export interface AdminUserRow {
  id: string;
  email: string;
  createdAt: string;
  region: string | null;
  creditBalance: number;
  spent: MoneyByCurrency;
  analyses: number;
  lastActiveAt: string | null;
  /** Where the account was first and last seen, by IP. Null until resolved. */
  firstSeen: AdminLocation | null;
  lastSeen: AdminLocation | null;
  /** Left out of every total, trend and list in the panel except Users. */
  excluded: boolean;
}

/**
 * The USD→INR rate the panel converts P&L with. Display only — null when no
 * rate is available, in which case the panel shows each currency unconverted.
 */
export interface AdminFx {
  usdInr: number | null;
  /** The rate's publication date (YYYY-MM-DD), when it came from the live source. */
  asOf: string | null;
  source: 'ecb' | 'configured' | null;
}

/** An IP-derived location: city-level at best, and VPNs can misplace it. */
export interface AdminLocation {
  country: string;
  region: string | null;
  city: string | null;
}

/** Users grouped by last-seen location. */
export interface AdminLocationCount extends AdminLocation {
  users: number;
}

export interface AdminLedgerRow {
  id: string;
  delta: number;
  reason: string;
  featureKey: string | null;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

export interface AdminUserDetail {
  user: AdminUserRow;
  payments: AdminPaymentRow[];
  ledger: AdminLedgerRow[];
  analyses: AdminAnalysisRow[];
}

export interface AdminActivity {
  range: AdminRange;
  analysisTrend: AdminDailyPoint[];
  bySource: { key: string; analyses: number; failed: number }[];
  watchlist: {
    items: number;
    itemsAdded: number;
    users: number;
    runs: Record<string, number>;
  };
  briefings: Record<string, number>;
}

export interface AdminErrorRow {
  id: string;
  profileId: string | null;
  email: string | null;
  category: string;
  message: string;
  detail: unknown;
  createdAt: string;
}

export interface AdminHealth {
  errors: AdminPage<AdminErrorRow>;
  errorsLast24h: number;
  failedAnalyses24h: number;
  failedAnalyses: AdminPage<AdminAnalysisRow>;
  /**
   * Payments still at 'created' well after checkout opened. The webhook event
   * log (webhook_events) was dropped with the move to credit billing, so this
   * is the persisted signal that a capture webhook may not have landed.
   */
  stalePayments: AdminPaymentRow[];
}
