import type {
  AdminBreakdownRow,
  AdminDailyPoint,
  AdminEconomicsTotals,
  AdminPaymentDailyPoint,
  AdminPaymentSummary,
  AdminRange,
  MoneyByCurrency,
} from "@tradesathi/shared";

/**
 * The Admin panel's financial rules, kept free of I/O so they can be tested
 * directly. The SQL functions in 20260921120000_admin_reporting.sql return
 * grouped rows; everything that decides what those groups *mean* is here.
 *
 * Two invariants hold throughout:
 *   - money is never added across currencies — every total is keyed by one;
 *   - AI cost is USD, and P&L is only computed against USD revenue, because
 *     the app has no configured exchange rate to convert INR with.
 */

/** A row of admin_payment_groups. */
export interface PaymentGroup {
  day: string;
  currency: string;
  status: string;
  signature_verified: boolean;
  payments: number;
  amount_minor: number;
}

/** A row of admin_analysis_groups. */
export interface AnalysisGroup {
  day: string;
  source: string;
  model_id: string;
  status: string;
  currency: string | null;
  analyses: number;
  cost_usd: number;
  credits: number;
  revenue_minor: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the reporting window, or null for all time. */
export function rangeSince(range: AdminRange, now: Date = new Date()): Date | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * DAY_MS);
}

export function parseRange(value: unknown): AdminRange {
  return value === "7d" || value === "all" ? value : "30d";
}

/** Minor units of `currency` to its major unit. Every currency here has 2 decimals. */
export function toMajor(minor: number): number {
  return minor / 100;
}

function addMoney(target: MoneyByCurrency, currency: string, minor: number): void {
  target[currency] = (target[currency] ?? 0) + minor;
}

/**
 * Cash revenue is every captured payment. signature_verified is not a trust
 * flag: false means the capture was confirmed by querying Razorpay's Orders
 * API (verify-order) rather than by a webhook signature — both are verified
 * captures (see the column comment in 20260916130000). Requiring it dropped
 * every capture that arrived through verify-order.
 */
export function isRevenue(group: Pick<PaymentGroup, "status">): boolean {
  return group.status === "captured";
}

export function summarizePayments(groups: readonly PaymentGroup[]): AdminPaymentSummary {
  const summary: AdminPaymentSummary = {
    revenue: {},
    capturedCount: 0,
    refunded: {},
    refundedCount: 0,
    failedCount: 0,
    createdCount: 0,
    totalCount: 0,
  };
  for (const g of groups) {
    const count = Number(g.payments);
    const amount = Number(g.amount_minor);
    summary.totalCount += count;
    if (isRevenue(g)) {
      addMoney(summary.revenue, g.currency, amount);
      summary.capturedCount += count;
    } else if (g.status === "refunded") {
      // A refunded payment was never kept, so it is reported beside revenue
      // rather than netted out of it: revenue above already excludes it.
      addMoney(summary.refunded, g.currency, amount);
      summary.refundedCount += count;
    } else if (g.status === "failed") {
      summary.failedCount += count;
    } else if (g.status === "created") {
      summary.createdCount += count;
    }
  }
  return summary;
}

export function paymentTrend(groups: readonly PaymentGroup[]): AdminPaymentDailyPoint[] {
  const byDay = new Map<string, MoneyByCurrency>();
  for (const g of groups) {
    if (!isRevenue(g)) continue;
    const day = byDay.get(g.day) ?? {};
    addMoney(day, g.currency, Number(g.amount_minor));
    byDay.set(g.day, day);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, revenue]) => ({ day, revenue }));
}

/** Bucket for an analysis whose account has no priced region. */
const UNPRICED = "unpriced";

/**
 * Estimated P&L in USD for analyses priced in `currency`, or null when that
 * currency is not USD and there is therefore nothing to subtract a USD cost
 * from without inventing an exchange rate.
 */
export function estimatedPnlUsd(
  currency: string | null,
  revenueMinor: number,
  costUsd: number,
): number | null {
  return currency === "USD" ? toMajor(revenueMinor) - costUsd : null;
}

export function foldEconomics(groups: readonly AnalysisGroup[]): AdminEconomicsTotals {
  const totals: AdminEconomicsTotals = {
    analyses: 0,
    credits: 0,
    revenue: {},
    aiCostUsd: 0,
    aiCostUsdByCurrency: {},
    estimatedPnlUsd: null,
    avgCostUsd: null,
    avgRevenue: {},
  };
  const analysesByCurrency: Record<string, number> = {};

  for (const g of groups) {
    const currency = g.currency ?? UNPRICED;
    const count = Number(g.analyses);
    const cost = Number(g.cost_usd);
    totals.analyses += count;
    totals.credits += Number(g.credits);
    totals.aiCostUsd += cost;
    totals.aiCostUsdByCurrency[currency] = (totals.aiCostUsdByCurrency[currency] ?? 0) + cost;
    analysesByCurrency[currency] = (analysesByCurrency[currency] ?? 0) + count;
    if (g.currency) addMoney(totals.revenue, g.currency, Number(g.revenue_minor));
  }

  if ("USD" in analysesByCurrency) {
    totals.estimatedPnlUsd = estimatedPnlUsd(
      "USD",
      totals.revenue["USD"] ?? 0,
      totals.aiCostUsdByCurrency["USD"] ?? 0,
    );
  }
  if (totals.analyses > 0) totals.avgCostUsd = totals.aiCostUsd / totals.analyses;
  for (const [currency, minor] of Object.entries(totals.revenue)) {
    const count = analysesByCurrency[currency] ?? 0;
    if (count > 0) totals.avgRevenue[currency] = Math.round(minor / count);
  }
  return totals;
}

export function breakdown(
  groups: readonly AnalysisGroup[],
  key: "source" | "model_id",
): AdminBreakdownRow[] {
  const buckets = new Map<string, AnalysisGroup[]>();
  for (const g of groups) {
    const list = buckets.get(g[key]) ?? [];
    list.push(g);
    buckets.set(g[key], list);
  }
  return [...buckets.entries()]
    .map(([k, list]) => ({ key: k, ...foldEconomics(list) }))
    .sort((a, b) => b.analyses - a.analyses);
}

export function analysisTrend(groups: readonly AnalysisGroup[]): AdminDailyPoint[] {
  const byDay = new Map<string, AdminDailyPoint>();
  for (const g of groups) {
    const point = byDay.get(g.day) ?? {
      day: g.day,
      analyses: 0,
      failed: 0,
      aiCostUsd: 0,
      revenue: {},
    };
    const count = Number(g.analyses);
    point.analyses += count;
    if (g.status === "failed") point.failed += count;
    point.aiCostUsd += Number(g.cost_usd);
    if (g.currency) addMoney(point.revenue, g.currency, Number(g.revenue_minor));
    byDay.set(g.day, point);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
