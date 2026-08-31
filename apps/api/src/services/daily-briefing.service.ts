import { renderCandlestickChart } from "./chart-image.service.js";
import { runVisualAnalysis, AnalysisFailure } from "./ai-analysis.service.js";
import type { AnalysisAiResult } from "./ai-analysis.service.js";
import {
  getEnabledWatchlistItems,
  getWatchlistItemForProfile,
  listProfilesWithEnabledWatchlist,
  type EnabledWatchlistItem,
} from "./watchlist.service.js";
import { YahooFinanceMarketDataProvider } from "../lib/market-data/yahoo-finance-provider.js";
import { MarketDataError, type MarketDataProvider } from "../lib/market-data/types.js";
import {
  buildDailyBriefingEmail,
  type BriefingItem,
  type FailedBriefingItem,
} from "../lib/email/daily-briefing-email.js";
import { sendEmail } from "../lib/email/resend-client.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

const CANDLE_LOOKBACK_DAYS = 90;
const CANDLES_FOR_CHART = 60;

const marketDataProvider: MarketDataProvider = new YahooFinanceMarketDataProvider();

function currentUtcPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type EntitlementOutcome = "consumed" | "no_subscription" | "quota_exhausted";

async function consumeDailyBriefingEntitlement(profileId: string): Promise<EntitlementOutcome> {
  const { data, error } = await supabaseAdmin.rpc(
    "check_and_consume_daily_briefing_entitlement",
    { p_profile_id: profileId },
  );
  if (error) throw error;
  return data as EntitlementOutcome;
}

/**
 * Compensating release for a Daily Briefing quota unit consumed but never
 * turned into a stored analysis (market-data fetch, chart render, or the AI
 * call failed). Same captured-period trade-offs as
 * analysis.service.ts's releaseEntitlement — see that function's doc comment
 * for the full reasoning; not re-derived here.
 */
async function releaseDailyBriefingEntitlement(
  profileId: string,
  period: string,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("decrement_daily_briefing_usage", {
    p_profile_id: profileId,
    p_period: period,
  });
  if (error) {
    logger.error("failed to release daily briefing entitlement", {
      profileId,
      period,
      cause: String(error),
    });
  }
}

interface ProcessedItem {
  item: EnabledWatchlistItem;
  analysisId: string;
  marketDataDate: string;
  latestPrice: number;
  analysis: AnalysisAiResult;
}

/**
 * Runs one watchlist item through: Yahoo Finance candles -> chart image -> the
 * SAME Visual AI pipeline used by manual uploads -> a new stored analysis row.
 * Returns null (having already released the quota unit it consumed) if
 * anything fails before a valid analysis is durably stored — quota must never
 * be spent on a failed attempt.
 */
export async function processWatchlistItem(
  profileId: string,
  item: EnabledWatchlistItem,
  period: string,
): Promise<ProcessedItem | null> {
  let candles;
  try {
    const toDate = todayIsoDate();
    candles = await marketDataProvider.getHistoricalCandles({
      instrumentKey: item.instrumentKey,
      unit: "days",
      interval: 1,
      toDate,
      fromDate: subtractDays(toDate, CANDLE_LOOKBACK_DAYS),
    });
  } catch (cause) {
    logger.error("watchlist item market-data fetch failed", {
      profileId,
      instrumentKey: item.instrumentKey,
      reason: cause instanceof MarketDataError ? cause.reason : "unknown",
      cause: String(cause),
    });
    await releaseDailyBriefingEntitlement(profileId, period);
    return null;
  }

  if (candles.length === 0) {
    logger.error("watchlist item returned zero candles", {
      profileId,
      instrumentKey: item.instrumentKey,
    });
    await releaseDailyBriefingEntitlement(profileId, period);
    return null;
  }

  const chartCandles = candles.slice(-CANDLES_FOR_CHART);
  const lastCandle = chartCandles[chartCandles.length - 1];

  let imageBuffer: Buffer;
  try {
    imageBuffer = await renderCandlestickChart(chartCandles, {
      symbol: item.symbol,
      name: item.name,
      exchange: item.exchange,
      timeframeLabel: "1D",
    });
  } catch (cause) {
    logger.error("chart image generation failed", {
      profileId,
      instrumentKey: item.instrumentKey,
      cause: String(cause),
    });
    await releaseDailyBriefingEntitlement(profileId, period);
    return null;
  }

  let visual;
  try {
    visual = await runVisualAnalysis(imageBuffer, "image/png");
  } catch (cause) {
    logger.error("watchlist item AI analysis failed", {
      profileId,
      instrumentKey: item.instrumentKey,
      errorCode: cause instanceof AnalysisFailure ? cause.code : "unknown",
      cause: String(cause),
    });
    await releaseDailyBriefingEntitlement(profileId, period);
    return null;
  }

  const marketDataDate = lastCandle.timestamp.slice(0, 10);

  const { data: insertedRow, error: insertError } = await supabaseAdmin
    .from("analyses")
    .insert({
    profile_id: profileId,
    source_type: "upload", // schema requires a value; not meaningful for this source — see note below
    source: "watchlist_daily",
    instrument_id: item.instrumentId,
    market_data_date: marketDataDate,
    image_key: `watchlist-daily/${profileId}/${item.instrumentId}/${marketDataDate}.png`,
    symbol_raw: visual.result.symbol,
    symbol: item.symbol,
    asset_class: visual.result.asset_class,
    timeframe: visual.result.timeframe,
    trend: visual.result.trend,
    volatility: visual.result.volatility,
    volume_reading: visual.result.volume,
    sentiment: visual.result.sentiment,
    support_levels: visual.result.support_levels,
    resistance_levels: visual.result.resistance_levels,
    call_direction: visual.result.call.direction,
    call_confidence: visual.result.call.confidence,
    call_entry: visual.result.call.entry,
    call_invalidation: visual.result.call.invalidation,
    call_target: visual.result.call.target,
    horizon_candles: visual.result.call.horizon_candles,
    summary: visual.result.summary,
    model_id: process.env["AI_MODEL"] ?? "unknown",
    prompt_version: "v2",
    input_tokens: visual.inputTokens,
    output_tokens: visual.outputTokens,
    latency_ms: visual.latencyMs,
    status: "complete",
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !insertedRow) {
    logger.error("failed to persist watchlist analysis", {
      profileId,
      instrumentKey: item.instrumentKey,
      cause: String(insertError),
    });
    await releaseDailyBriefingEntitlement(profileId, period);
    return null;
  }

  // Note on image_key/source_type above: the analyses table's image_key and
  // source_type columns are NOT NULL, written by the manual-upload path
  // against a real Supabase Storage object. The watchlist path has no
  // uploaded file to point at (the chart image is generated in-memory and
  // discarded, exactly like the spec asks — no new storage/design system for
  // this path), so image_key is a synthetic, uniquely-derived path used only
  // as a human-readable identifier, and source_type is a placeholder required
  // by the column's NOT NULL constraint. source = 'watchlist_daily' is the
  // real, authoritative provenance signal — see the analyses-source-column
  // migration.
  return {
    item,
    analysisId: insertedRow.id,
    marketDataDate,
    latestPrice: lastCandle.close,
    analysis: visual.result,
  };
}

export async function runDailyBriefingForUser(profileId: string): Promise<void> {
  const briefingDate = todayIsoDate();

  const { error: logInsertError } = await supabaseAdmin
    .from("daily_briefing_log")
    .insert({ profile_id: profileId, briefing_date: briefingDate, status: "processing" });

  if (logInsertError) {
    // Unique-violation on (profile_id, briefing_date) means today's briefing
    // already ran (or is currently running) for this user — the idempotency
    // guard doing exactly its job. Any other error is unexpected and logged,
    // but this run still stops rather than risk a duplicate email.
    if (logInsertError.code !== "23505") {
      logger.error("failed to write daily_briefing_log row", {
        profileId,
        cause: String(logInsertError),
      });
    }
    return;
  }

  const items = await getEnabledWatchlistItems(profileId);
  if (items.length === 0) {
    await supabaseAdmin
      .from("daily_briefing_log")
      .update({ status: "skipped_no_symbols", updated_at: new Date().toISOString() })
      .eq("profile_id", profileId)
      .eq("briefing_date", briefingDate);
    return;
  }

  const period = currentUtcPeriod();
  const succeeded: BriefingItem[] = [];
  const failed: FailedBriefingItem[] = [];
  let entitlementExhausted = false;

  for (const item of items) {
    if (entitlementExhausted) break;

    const outcome = await consumeDailyBriefingEntitlement(profileId);
    if (outcome === "no_subscription") {
      // No Daily Briefing entitlement at all: stop immediately, no market-data/AI
      // calls for any symbol, no email. Distinct terminal status from
      // 'skipped_quota_exhausted' for observability.
      await supabaseAdmin
        .from("daily_briefing_log")
        .update({ status: "skipped_no_entitlement", updated_at: new Date().toISOString() })
        .eq("profile_id", profileId)
        .eq("briefing_date", briefingDate);
      return;
    }
    if (outcome === "quota_exhausted") {
      entitlementExhausted = true;
      break;
    }

    const processed = await processWatchlistItem(profileId, item, period);
    if (processed) {
      succeeded.push({
        symbol: processed.item.symbol,
        name: processed.item.name,
        marketDataDate: processed.marketDataDate,
        latestPrice: processed.latestPrice,
        analysis: processed.analysis,
      });
    } else {
      failed.push({ symbol: item.symbol, name: item.name });
    }
  }

  if (succeeded.length === 0 && failed.length === 0) {
    // Every item was skipped because quota ran out before any could even be
    // attempted (e.g. a user with zero remaining quota this period).
    await supabaseAdmin
      .from("daily_briefing_log")
      .update({ status: "skipped_quota_exhausted", updated_at: new Date().toISOString() })
      .eq("profile_id", profileId)
      .eq("briefing_date", briefingDate);
    return;
  }

  if (succeeded.length === 0) {
    // Every attempted symbol failed; nothing worth emailing.
    await supabaseAdmin
      .from("daily_briefing_log")
      .update({
        status: "failed",
        symbols_failed: failed.length,
        updated_at: new Date().toISOString(),
      })
      .eq("profile_id", profileId)
      .eq("briefing_date", briefingDate);
    return;
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("email")
    .eq("id", profileId)
    .single<{ email: string }>();

  if (profileError || !profile) {
    logger.error("failed to load profile email for daily briefing", {
      profileId,
      cause: String(profileError),
    });
    await supabaseAdmin
      .from("daily_briefing_log")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("profile_id", profileId)
      .eq("briefing_date", briefingDate);
    return;
  }

  const { subject, html } = buildDailyBriefingEmail(briefingDate, succeeded, failed);

  try {
    await sendEmail({ to: profile.email, subject, html });
  } catch (cause) {
    logger.error("failed to send daily briefing email", {
      profileId,
      cause: String(cause),
    });
    await supabaseAdmin
      .from("daily_briefing_log")
      .update({
        status: "failed",
        symbols_sent: succeeded.length,
        symbols_failed: failed.length,
        updated_at: new Date().toISOString(),
      })
      .eq("profile_id", profileId)
      .eq("briefing_date", briefingDate);
    return;
  }

  await supabaseAdmin
    .from("daily_briefing_log")
    .update({
      status: failed.length > 0 ? "sent_partial" : "sent",
      symbols_sent: succeeded.length,
      symbols_failed: failed.length,
      updated_at: new Date().toISOString(),
    })
    .eq("profile_id", profileId)
    .eq("briefing_date", briefingDate);
}

export type AnalyzeNowResult =
  | { ok: true; instrumentId: string; startedAt: string }
  | { ok: false; reason: "not_found" | "no_subscription" | "quota_exhausted" };

/**
 * User-triggered, single-item counterpart to the scheduled job — the
 * "Analyze Now" button on a watchlist row. Shares the exact same entitlement
 * (same 30/month quota, same subscription check) and the exact same
 * fetch/chart/AI/persist pipeline (processWatchlistItem) as the scheduled
 * run, so there is only one code path that can ever write a
 * source='watchlist_daily' analysis row.
 *
 * Deliberately does NOT touch daily_briefing_log or send an email: those are
 * the once-a-day digest's concerns.
 *
 * Deliberately asynchronous: the underlying pipeline (market data + chart
 * render + AI call) routinely takes 20-30+ seconds, which exceeds the idle
 * timeout of proxies/tunnels a mobile client may be behind (e.g. zrok's
 * public frontend). This function only performs the fast, synchronous
 * checks (item lookup, entitlement) and returns as soon as those pass;
 * processWatchlistItem then runs uninitiated in the background and persists
 * its own analyses row on completion. The caller (the route) responds
 * immediately, and the client polls the analyses table (readable under RLS)
 * for a fresh row instead of waiting on this call.
 */
export async function analyzeWatchlistItemNow(
  profileId: string,
  watchlistItemId: string,
): Promise<AnalyzeNowResult> {
  const item = await getWatchlistItemForProfile(profileId, watchlistItemId);
  if (!item) return { ok: false, reason: "not_found" };

  const outcome = await consumeDailyBriefingEntitlement(profileId);
  if (outcome === "no_subscription") return { ok: false, reason: "no_subscription" };
  if (outcome === "quota_exhausted") return { ok: false, reason: "quota_exhausted" };

  const period = currentUtcPeriod();
  const startedAt = new Date().toISOString();

  // Deliberately not awaited: see the doc comment above. Failures are
  // already logged and compensated (quota release) inside
  // processWatchlistItem itself.
  void processWatchlistItem(profileId, item, period).catch((cause) => {
    logger.error("watchlist analyze-now background processing failed", {
      profileId,
      watchlistItemId,
      cause: String(cause),
    });
  });

  return { ok: true, instrumentId: item.instrumentId, startedAt };
}

/**
 * Entry point for both the scheduler and the internal manual-trigger route.
 * Iterates every profile with at least one daily-analysis-enabled watchlist
 * item; one profile's failure never aborts the run for the rest.
 */
export async function runDailyBriefingForAllUsers(): Promise<void> {
  const profileIds = await listProfilesWithEnabledWatchlist();
  logger.info("daily briefing run starting", { profileCount: profileIds.length });

  for (const profileId of profileIds) {
    try {
      await runDailyBriefingForUser(profileId);
    } catch (cause) {
      logger.error("daily briefing run failed for profile", {
        profileId,
        cause: String(cause),
      });
    }
  }

  logger.info("daily briefing run complete", { profileCount: profileIds.length });
}
