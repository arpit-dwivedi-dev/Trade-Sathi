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

// Upper bound on candles drawn, not on candles fetched: the renderer has a
// fixed 1200px width, and past this the individual candles stop being
// readable (and so stop being analysable). A longer per-item lookback still
// widens the window; it just keeps the most recent MAX_CANDLES_FOR_CHART of
// it. The per-item lookback itself lives in watchlist_items.
const MAX_CANDLES_FOR_CHART = 250;

/**
 * Candle granularity for a chart window. A one-day or one-week window has too
 * few daily candles to read anything from (one, and about five), so short
 * windows are drawn from intraday candles instead. The thresholds are also
 * bounded by the provider: intraday history upstream goes back days, not
 * months, so nothing beyond a week asks for it.
 */
function candleSpecFor(lookbackDays: number): {
  unit: "minutes" | "days";
  interval: number;
  label: string;
} {
  if (lookbackDays <= 1) return { unit: "minutes", interval: 5, label: "5m" };
  if (lookbackDays <= 7) return { unit: "minutes", interval: 30, label: "30m" };
  return { unit: "days", interval: 1, label: "1D" };
}

const BUCKET = "chart-images";

const IST_OFFSET_MINUTES = 5.5 * 60;

const marketDataProvider: MarketDataProvider = new YahooFinanceMarketDataProvider();

function currentUtcPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Current hour (0-23) in IST, the timezone every schedule setting is in. */
function currentIstHour(): number {
  const istMs = Date.now() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).getUTCHours();
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Stores a generated watchlist chart so the user can see the exact image the
 * analysis was read from, the same way they can for an uploaded screenshot.
 *
 * The leading path segment MUST be the profile id: the chart-images bucket's
 * SELECT policy authorises a read by matching `(storage.foldername(name))[1]`
 * against auth.uid(). A key that starts with anything else uploads fine (the
 * service role bypasses RLS on write) and is then unreadable by the only
 * person meant to see it.
 *
 * A failure is logged and swallowed, deliberately: the AI result is already
 * complete and useful, and discarding it — along with the quota unit and the
 * provider spend behind it — over a missing picture would be a worse outcome.
 * The row keeps the key either way, so a failed store surfaces as an image
 * that will not load rather than as a silently different kind of analysis.
 */
async function storeWatchlistChart(imageKey: string, imageBuffer: Buffer): Promise<void> {
  // upsert: the scheduled job and an Analyze Now run on the same instrument
  // and the same market-data date derive the identical key. Without this the
  // second one fails on a duplicate object for what is genuinely the same
  // chart.
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(imageKey, imageBuffer, { contentType: "image/png", upsert: true });

  if (error) {
    logger.error("watchlist chart image upload failed", {
      imageKey,
      cause: String(error),
    });
  }
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
  const spec = candleSpecFor(item.analysisLookbackDays);
  let candles;
  try {
    const toDate = todayIsoDate();
    const fromDate = subtractDays(toDate, item.analysisLookbackDays);
    const fetched = await marketDataProvider.getHistoricalCandles({
      instrumentKey: item.instrumentKey,
      unit: spec.unit,
      interval: spec.interval,
      toDate,
      fromDate,
    });
    // The provider widens the request to the nearest range its upstream
    // accepts, so anything older than the window the user asked for is
    // dropped here rather than quietly drawn.
    candles = fetched.filter((candle) => candle.timestamp.slice(0, 10) >= fromDate);
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

  const chartCandles = candles.slice(-MAX_CANDLES_FOR_CHART);
  const lastCandle = chartCandles[chartCandles.length - 1];

  let imageBuffer: Buffer;
  try {
    imageBuffer = await renderCandlestickChart(chartCandles, {
      symbol: item.symbol,
      name: item.name,
      exchange: item.exchange,
      // Granularity and window together, e.g. "1D · 90d" or "5m · 1d".
      timeframeLabel: `${spec.label} · ${item.analysisLookbackDays}d`,
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
  // The lookback is part of the key: two runs on the same instrument and the
  // same market-data date but different windows render genuinely different
  // charts, and a shared key would leave the earlier analysis pointing at the
  // later run's image.
  const imageKey = `${profileId}/watchlist-daily/${item.instrumentId}/${marketDataDate}-${item.analysisLookbackDays}d.png`;
  await storeWatchlistChart(imageKey, imageBuffer);

  const { data: insertedRow, error: insertError } = await supabaseAdmin
    .from("analyses")
    .insert({
    profile_id: profileId,
    source_type: "upload", // schema requires a value; not meaningful for this source — see note below
    source: "watchlist_daily",
    instrument_id: item.instrumentId,
    market_data_date: marketDataDate,
    image_key: imageKey,
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
    analysis_lookback_days: item.analysisLookbackDays,
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

  // Note on image_key/source_type above: image_key points at a real stored
  // object, exactly as it does for the manual-upload path — the generated
  // chart is uploaded above so the user can see the image their analysis was
  // read from. source_type stays a placeholder required by that column's NOT
  // NULL constraint; source = 'watchlist_daily' is the real, authoritative
  // provenance signal — see the analyses-source-column migration.
  return {
    item,
    analysisId: insertedRow.id,
    marketDataDate,
    latestPrice: lastCandle.close,
    analysis: visual.result,
  };
}

export async function runDailyBriefingForUser(
  profileId: string,
  runHourIst?: number,
): Promise<void> {
  const briefingDate = todayIsoDate();
  // The log row is keyed by (profile, date, hour), so the idempotency guard is
  // per scheduled slot now that symbols can be scheduled at different hours.
  // An ops manual trigger (no hour) is logged against the current IST hour.
  const logHourIst = runHourIst ?? currentIstHour();

  const { error: logInsertError } = await supabaseAdmin
    .from("daily_briefing_log")
    .insert({
      profile_id: profileId,
      briefing_date: briefingDate,
      run_hour_ist: logHourIst,
      status: "processing",
    });

  if (logInsertError) {
    // Unique-violation on (profile_id, briefing_date, run_hour_ist) means this
    // slot's briefing already ran (or is currently running) for this user — the idempotency
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

  const items = await getEnabledWatchlistItems(profileId, runHourIst);
  if (items.length === 0) {
    await supabaseAdmin
      .from("daily_briefing_log")
      .update({ status: "skipped_no_symbols", updated_at: new Date().toISOString() })
      .eq("profile_id", profileId)
      .eq("briefing_date", briefingDate)
      .eq("run_hour_ist", logHourIst);
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
      .eq("briefing_date", briefingDate)
      .eq("run_hour_ist", logHourIst);
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
      .eq("briefing_date", briefingDate)
      .eq("run_hour_ist", logHourIst);
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
      .eq("briefing_date", briefingDate)
      .eq("run_hour_ist", logHourIst);
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
      .eq("briefing_date", briefingDate)
      .eq("run_hour_ist", logHourIst);
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
    .eq("briefing_date", briefingDate)
    .eq("run_hour_ist", logHourIst);
}

export type AnalyzeNowResult =
  | { ok: true; runId: string; instrumentId: string; startedAt: string }
  | { ok: false; reason: "not_found" | "no_subscription" | "quota_exhausted" }
  // The one non-terminal outcome: the user has already analysed this exact
  // stock over this exact window recently. Re-running is allowed — it just
  // needs an explicit confirmation (force), since it spends another unit of
  // the same 30/month quota on a chart that has not changed.
  | { ok: false; reason: "duplicate"; lastAnalysisAt: string; lookbackDays: number };

/** How long a completed analysis makes an identical re-run look like a mistake. */
const DUPLICATE_WINDOW_HOURS = 24;

/**
 * The most recent completed analysis of this instrument over this exact
 * lookback window, if one is recent enough to be worth warning about.
 * Instrument + window (not the raw symbol) because those two are precisely
 * what determine the chart the model reads.
 */
async function findRecentIdenticalAnalysis(
  profileId: string,
  instrumentId: string,
  lookbackDays: number,
): Promise<string | null> {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("analyses")
    .select("created_at")
    .eq("profile_id", profileId)
    .eq("instrument_id", instrumentId)
    .eq("analysis_lookback_days", lookbackDays)
    .eq("status", "complete")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ created_at: string }>();

  // A failed duplicate lookup must not block a run the user asked for: the
  // check is a courtesy warning, not an entitlement guard.
  if (error) {
    logger.error("duplicate-analysis lookup failed", { profileId, cause: String(error) });
    return null;
  }
  return data?.created_at ?? null;
}

/** Marks an Analyze Now run row settled; failures here are logged, not thrown. */
async function settleRun(
  runId: string,
  status: "complete" | "failed",
  analysisId: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("watchlist_analysis_runs")
    .update({ status, analysis_id: analysisId, updated_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) logger.error("failed to settle watchlist run", { runId, cause: String(error) });
}

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
  force = false,
): Promise<AnalyzeNowResult> {
  const item = await getWatchlistItemForProfile(profileId, watchlistItemId);
  if (!item) return { ok: false, reason: "not_found" };

  // Before the entitlement is touched: a duplicate must not cost a quota unit
  // on the way to being refused.
  if (!force) {
    const lastAnalysisAt = await findRecentIdenticalAnalysis(
      profileId,
      item.instrumentId,
      item.analysisLookbackDays,
    );
    if (lastAnalysisAt) {
      return {
        ok: false,
        reason: "duplicate",
        lastAnalysisAt,
        lookbackDays: item.analysisLookbackDays,
      };
    }
  }

  const outcome = await consumeDailyBriefingEntitlement(profileId);
  if (outcome === "no_subscription") return { ok: false, reason: "no_subscription" };
  if (outcome === "quota_exhausted") return { ok: false, reason: "quota_exhausted" };

  const period = currentUtcPeriod();
  const startedAt = new Date().toISOString();

  // Written before the pipeline starts, so the run exists somewhere other than
  // in the requesting tab's memory: a reload, a different device, or a client
  // that was closed mid-run can all still find this run and its outcome.
  const { data: runRow, error: runError } = await supabaseAdmin
    .from("watchlist_analysis_runs")
    .insert({
      profile_id: profileId,
      watchlist_item_id: item.watchlistItemId,
      instrument_id: item.instrumentId,
      lookback_days: item.analysisLookbackDays,
      status: "processing",
    })
    .select("id")
    .single<{ id: string }>();

  if (runError || !runRow) {
    // The quota unit was already consumed above, so release it rather than
    // charge for a run that is not going to be started.
    logger.error("failed to record watchlist analysis run", {
      profileId,
      watchlistItemId,
      cause: String(runError),
    });
    await releaseDailyBriefingEntitlement(profileId, period);
    throw new Error("Could not start analysis");
  }

  // Deliberately not awaited: see the doc comment above. Failures are
  // already logged and compensated (quota release) inside
  // processWatchlistItem itself; settling the run row here is what turns
  // that into something the user can see after a reload.
  void processWatchlistItem(profileId, item, period)
    .then((processed) => settleRun(runRow.id, processed ? "complete" : "failed", processed?.analysisId ?? null))
    .catch(async (cause: unknown) => {
      logger.error("watchlist analyze-now background processing failed", {
        profileId,
        watchlistItemId,
        cause: String(cause),
      });
      await settleRun(runRow.id, "failed", null);
    });

  return { ok: true, runId: runRow.id, instrumentId: item.instrumentId, startedAt };
}

/**
 * Entry point for both the scheduler and the internal manual-trigger route.
 * Iterates every profile with at least one daily-analysis-enabled watchlist
 * item; one profile's failure never aborts the run for the rest.
 */
export async function runDailyBriefingForAllUsers(runHourIst?: number): Promise<void> {
  const profileIds = await listProfilesWithEnabledWatchlist(runHourIst);
  logger.info("daily briefing run starting", {
    profileCount: profileIds.length,
    runHourIst: runHourIst ?? "all",
  });

  for (const profileId of profileIds) {
    try {
      await runDailyBriefingForUser(profileId, runHourIst);
    } catch (cause) {
      logger.error("daily briefing run failed for profile", {
        profileId,
        cause: String(cause),
      });
    }
  }

  logger.info("daily briefing run complete", { profileCount: profileIds.length });
}
