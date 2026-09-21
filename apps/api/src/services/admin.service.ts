import type {
  AdminActivity,
  AdminAnalysisRow,
  AdminEconomics,
  AdminErrorRow,
  AdminHealth,
  AdminLedgerRow,
  AdminLocation,
  AdminOverview,
  AdminPage,
  AdminPaymentRow,
  AdminPayments,
  AdminRange,
  AdminUserDetail,
  AdminUserRow,
} from "@tradesathi/shared";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";
import { getUsdInr } from "./fx.service.js";
import {
  analysisTrend,
  breakdown,
  estimatedPnlUsd,
  foldEconomics,
  paymentTrend,
  rangeSince,
  summarizePayments,
  type AnalysisGroup,
  type PaymentGroup,
} from "./admin-metrics.js";

/**
 * Read-only reporting for the Admin panel. Every read here goes through the
 * service-role client, so it must only ever be reached from behind
 * requireAdmin (routes/admin.route.ts).
 */

export interface PageParams {
  limit: number;
  offset: number;
}

/** Recent-history cap for the per-user detail lists and the Health side lists. */
const DETAIL_LIMIT = 100;

/** A payment still 'created' this long after checkout opened is treated as stuck. */
const STALE_PAYMENT_MS = 30 * 60 * 1000;

interface AnalysisDbRow {
  id: string;
  profile_id: string;
  email: string;
  source: string;
  model_id: string;
  status: string;
  cost_usd: number | null;
  credits: number;
  revenue_minor: number;
  currency: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  total_count: number;
}

interface PaymentDbRow {
  id: string;
  profile_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  signature_verified: boolean;
  credits_purchased: number;
  created_at: string;
  captured_at: string | null;
  // PostgREST returns a to-one embed as an object; typed loosely because the
  // client here is not generated from the schema.
  profiles: { email: string } | { email: string }[] | null;
}

interface UserDbRow {
  id: string;
  email: string;
  created_at: string;
  pricing_region: string | null;
  credit_balance: number;
  spent: Record<string, number>;
  analyses: number;
  last_active_at: string | null;
  first_seen_country: string | null;
  first_seen_region: string | null;
  first_seen_city: string | null;
  last_seen_country: string | null;
  last_seen_region: string | null;
  last_seen_city: string | null;
  total_count: number;
}

interface ErrorDbRow {
  id: string;
  profile_id: string | null;
  category: string;
  message: string;
  detail: unknown;
  created_at: string;
  profiles: { email: string } | { email: string }[] | null;
}

const PAYMENT_COLUMNS =
  "id, profile_id, amount_minor, currency, status, signature_verified, credits_purchased, created_at, captured_at, profiles(email)";

function embeddedEmail(embed: PaymentDbRow["profiles"]): string | null {
  if (!embed) return null;
  return Array.isArray(embed) ? (embed[0]?.email ?? null) : embed.email;
}

function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function toAnalysisRow(row: AnalysisDbRow): AdminAnalysisRow {
  const costUsd = row.cost_usd === null ? null : Number(row.cost_usd);
  return {
    id: row.id,
    profileId: row.profile_id,
    email: row.email,
    source: row.source,
    modelId: row.model_id,
    status: row.status,
    credits: Number(row.credits),
    revenueMinor: Number(row.revenue_minor),
    currency: row.currency,
    costUsd,
    // Unknown cost stays unknown: counting it as 0 would report the whole revenue as profit.
    estimatedPnlUsd:
      costUsd === null ? null : estimatedPnlUsd(row.currency, Number(row.revenue_minor), costUsd),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function toPaymentRow(row: PaymentDbRow): AdminPaymentRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    email: embeddedEmail(row.profiles),
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    signatureVerified: row.signature_verified,
    creditsPurchased: row.credits_purchased,
    createdAt: row.created_at,
    capturedAt: row.captured_at,
  };
}

function location(
  country: string | null,
  region: string | null,
  city: string | null,
): AdminLocation | null {
  return country ? { country, region, city } : null;
}

function toUserRow(row: UserDbRow): AdminUserRow {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    region: row.pricing_region,
    creditBalance: row.credit_balance,
    spent: row.spent ?? {},
    analyses: Number(row.analyses),
    lastActiveAt: row.last_active_at,
    firstSeen: location(row.first_seen_country, row.first_seen_region, row.first_seen_city),
    lastSeen: location(row.last_seen_country, row.last_seen_region, row.last_seen_city),
  };
}

function page<T>(rows: T[], total: number, params: PageParams): AdminPage<T> {
  return { rows, total, limit: params.limit, offset: params.offset };
}

/**
 * The window count the paged SQL functions put on every row. A page past the
 * end has no rows to carry it, so that case asks again from the start for one
 * row — otherwise the total would read 0 while matching rows exist.
 */
async function pagedTotal(
  rows: readonly { total_count: number | string }[],
  params: PageParams,
  refetchFirst: () => Promise<readonly { total_count: number | string }[]>,
): Promise<number> {
  if (rows.length > 0) return Number(rows[0].total_count);
  if (params.offset === 0) return 0;
  return Number((await refetchFirst())[0]?.total_count ?? 0);
}

async function analysisGroups(since: Date | null): Promise<AnalysisGroup[]> {
  return callRpc<AnalysisGroup[]>("admin_analysis_groups", { p_since: isoOrNull(since) });
}

async function paymentGroups(since: Date | null): Promise<PaymentGroup[]> {
  return callRpc<PaymentGroup[]>("admin_payment_groups", { p_since: isoOrNull(since) });
}

interface AnalysisQuery {
  since?: Date | null;
  source?: string | null;
  model?: string | null;
  status?: string | null;
  profileId?: string | null;
}

async function analysisPage(
  query: AnalysisQuery,
  params: PageParams,
): Promise<AdminPage<AdminAnalysisRow>> {
  const fetch = (limit: number, offset: number) =>
    callRpc<AnalysisDbRow[]>("admin_analysis_rows", {
      p_since: isoOrNull(query.since ?? null),
      p_source: query.source ?? null,
      p_model: query.model ?? null,
      p_status: query.status ?? null,
      p_profile_id: query.profileId ?? null,
      p_limit: limit,
      p_offset: offset,
    });
  const rows = await fetch(params.limit, params.offset);
  const total = await pagedTotal(rows, params, () => fetch(1, 0));
  return page(rows.map(toAnalysisRow), total, params);
}

export async function getOverview(range: AdminRange): Promise<AdminOverview> {
  const since = rangeSince(range);
  const [users, analyses, payments, locations, fx] = await Promise.all([
    callRpc<AdminOverview["users"]>("admin_user_counts", { p_since: isoOrNull(since) }),
    analysisGroups(since),
    paymentGroups(since),
    callRpc<{ country: string; region: string | null; city: string | null; users: number | string }[]>(
      "admin_location_counts",
      {},
    ),
    getUsdInr(),
  ]);
  return {
    range,
    users,
    payments: summarizePayments(payments),
    economics: foldEconomics(analyses),
    failedAnalyses: analyses
      .filter((g) => g.status === "failed")
      .reduce((sum, g) => sum + Number(g.analyses), 0),
    analysisTrend: analysisTrend(analyses),
    revenueTrend: paymentTrend(payments),
    locations: locations.map((l) => ({ ...l, users: Number(l.users) })),
    fx,
  };
}

export interface EconomicsQuery extends PageParams {
  range: AdminRange;
  source: string | null;
  model: string | null;
  status: string | null;
}

export async function getEconomics(query: EconomicsQuery): Promise<AdminEconomics> {
  const since = rangeSince(query.range);
  // Fetched unfiltered so the filter dropdowns can offer every value in the
  // window; the grouped result is small, so the filters apply here.
  const [groups, rows, fx] = await Promise.all([
    analysisGroups(since),
    analysisPage({ since, source: query.source, model: query.model, status: query.status }, query),
    getUsdInr(),
  ]);
  const filtered = groups.filter(
    (g) =>
      (query.source === null || g.source === query.source) &&
      (query.model === null || g.model_id === query.model) &&
      (query.status === null || g.status === query.status),
  );
  const distinct = (pick: (g: AnalysisGroup) => string) => [...new Set(groups.map(pick))].sort();
  return {
    totals: foldEconomics(filtered),
    bySource: breakdown(filtered, "source"),
    byModel: breakdown(filtered, "model_id"),
    filters: {
      sources: distinct((g) => g.source),
      models: distinct((g) => g.model_id),
      statuses: distinct((g) => g.status),
    },
    page: rows,
    fx,
  };
}

export interface PaymentsQuery extends PageParams {
  range: AdminRange;
  status: string | null;
  currency: string | null;
}

export async function getPayments(query: PaymentsQuery): Promise<AdminPayments> {
  const since = rangeSince(query.range);

  let list = supabaseAdmin
    .from("payments")
    .select(PAYMENT_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(query.offset, query.offset + query.limit - 1);
  if (since) list = list.gte("created_at", since.toISOString());
  if (query.status) list = list.eq("status", query.status);
  if (query.currency) list = list.eq("currency", query.currency);

  const [groups, listed] = await Promise.all([paymentGroups(since), list]);
  if (listed.error) throw new Error(`payments list failed: ${listed.error.message}`);

  return {
    summary: summarizePayments(groups),
    trend: paymentTrend(groups),
    page: page(
      ((listed.data ?? []) as PaymentDbRow[]).map(toPaymentRow),
      listed.count ?? 0,
      query,
    ),
  };
}

/** Escapes LIKE wildcards so a search for "a_b" matches that text literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface UsersQuery extends PageParams {
  search: string | null;
}

export async function listUsers(query: UsersQuery): Promise<AdminPage<AdminUserRow>> {
  const fetch = (limit: number, offset: number) =>
    callRpc<UserDbRow[]>("admin_user_rows", {
      p_search: query.search ? escapeLike(query.search) : null,
      p_limit: limit,
      p_offset: offset,
    });
  const rows = await fetch(query.limit, query.offset);
  const total = await pagedTotal(rows, query, () => fetch(1, 0));
  return page(rows.map(toUserRow), total, query);
}

export async function getUserDetail(profileId: string): Promise<AdminUserDetail | null> {
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select(
      "id, email, created_at, pricing_region, credit_balance, first_seen_country, first_seen_region, first_seen_city, last_seen_country, last_seen_region, last_seen_city",
    )
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  if (!profile) return null;

  const recent = { limit: DETAIL_LIMIT, offset: 0 };
  const [payments, ledger, analyses, lastActiveAt, spent] = await Promise.all([
    supabaseAdmin
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_LIMIT),
    supabaseAdmin
      .from("credit_ledger")
      .select("id, delta, reason, feature_key, balance_after, note, created_at")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_LIMIT),
    analysisPage({ profileId }, recent),
    // Scheduled briefings are excluded: they run whether or not the user shows up.
    callRpc<string | null>("admin_last_action_at", { p_profile_id: profileId }),
    // Lifetime spend from SQL, not from the payments list above: that list is
    // capped at DETAIL_LIMIT and would undercount past it.
    callRpc<Record<string, number> | null>("admin_user_spent", { p_profile_id: profileId }),
  ]);
  if (payments.error) throw new Error(`user payments failed: ${payments.error.message}`);
  if (ledger.error) throw new Error(`user ledger failed: ${ledger.error.message}`);

  const paymentRows = ((payments.data ?? []) as PaymentDbRow[]).map(toPaymentRow);
  const row = profile as Omit<UserDbRow, "spent" | "analyses" | "total_count" | "last_active_at">;
  const user = toUserRow({ ...row, spent: spent ?? {}, analyses: analyses.total, last_active_at: lastActiveAt, total_count: 0 });

  return {
    user,
    payments: paymentRows,
    ledger: ((ledger.data ?? []) as {
      id: string;
      delta: number;
      reason: string;
      feature_key: string | null;
      balance_after: number;
      note: string | null;
      created_at: string;
    }[]).map(
      (l): AdminLedgerRow => ({
        id: l.id,
        delta: l.delta,
        reason: l.reason,
        featureKey: l.feature_key,
        balanceAfter: l.balance_after,
        note: l.note,
        createdAt: l.created_at,
      }),
    ),
    analyses: analyses.rows,
  };
}

interface ActivityCounts {
  watchlistItems: number;
  watchlistItemsAdded: number;
  watchlistUsers: number;
  watchlistRuns: Record<string, number>;
  briefings: Record<string, number>;
}

export async function getActivity(range: AdminRange): Promise<AdminActivity> {
  const since = rangeSince(range);
  const [groups, counts] = await Promise.all([
    analysisGroups(since),
    callRpc<ActivityCounts>("admin_activity_counts", { p_since: isoOrNull(since) }),
  ]);

  const bySource = new Map<string, { key: string; analyses: number; failed: number }>();
  for (const g of groups) {
    const entry = bySource.get(g.source) ?? { key: g.source, analyses: 0, failed: 0 };
    entry.analyses += Number(g.analyses);
    if (g.status === "failed") entry.failed += Number(g.analyses);
    bySource.set(g.source, entry);
  }

  return {
    range,
    analysisTrend: analysisTrend(groups),
    bySource: [...bySource.values()].sort((a, b) => b.analyses - a.analyses),
    watchlist: {
      items: counts.watchlistItems,
      itemsAdded: counts.watchlistItemsAdded,
      users: counts.watchlistUsers,
      runs: counts.watchlistRuns,
    },
    briefings: counts.briefings,
  };
}

export async function getHealth(params: PageParams): Promise<AdminHealth> {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const staleBefore = new Date(now - STALE_PAYMENT_MS).toISOString();

  const [errors, errors24h, failedPage, failed24h, stale] = await Promise.all([
    supabaseAdmin
      .from("app_error_logs")
      .select("id, profile_id, category, message, detail, created_at, profiles(email)", {
        count: "exact",
      })
      .order("created_at", { ascending: false })
      .range(params.offset, params.offset + params.limit - 1),
    supabaseAdmin
      .from("app_error_logs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", dayAgo),
    analysisPage({ status: "failed" }, { limit: 20, offset: 0 }),
    supabaseAdmin
      .from("analyses")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("created_at", dayAgo),
    supabaseAdmin
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("status", "created")
      .lt("created_at", staleBefore)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  for (const result of [errors, errors24h, failed24h, stale]) {
    if (result.error) throw new Error(`health read failed: ${result.error.message}`);
  }

  return {
    errors: page(
      ((errors.data ?? []) as ErrorDbRow[]).map(
        (e): AdminErrorRow => ({
          id: e.id,
          profileId: e.profile_id,
          email: embeddedEmail(e.profiles),
          category: e.category,
          message: e.message,
          detail: e.detail,
          createdAt: e.created_at,
        }),
      ),
      errors.count ?? 0,
      params,
    ),
    errorsLast24h: errors24h.count ?? 0,
    failedAnalyses24h: failed24h.count ?? 0,
    failedAnalyses: failedPage,
    stalePayments: ((stale.data ?? []) as PaymentDbRow[]).map(toPaymentRow),
  };
}
