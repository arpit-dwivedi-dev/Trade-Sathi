import type { AnalysisAiResult } from "./ai-analysis.service.js";
import { runInstrumentAnalysis, type ProvidedChart } from "./instrument-analysis.service.js";
import { todayIsoDate, type InstrumentRef } from "./market-chart.service.js";
import {
  getEnabledWatchlistItems,
  getWatchlistItemForProfile,
  listProfilesWithEnabledWatchlist,
  type EnabledWatchlistItem,
} from "./watchlist.service.js";
import {
  buildDailyBriefingEmail,
  type BriefingItem,
  type FailedBriefingItem,
} from "../lib/email/daily-briefing-email.js";
import { sendEmail } from "../lib/email/resend-client.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

const IST_OFFSET_MINUTES = 5.5 * 60;

function currentUtcPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Current hour (0-23) in IST, the timezone every schedule setting is in. */
function currentIstHour(): number {
  const istMs = Date.now() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).getUTCHours();
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
 * Runs one watchlist item through the shared instrument pipeline (candles ->
 * chart image -> the SAME visual AI call manual uploads use -> a stored
 * analysis row). Returns null — having already released the Daily Briefing
 * quota unit its caller consumed — if anything fails before a valid analysis
 * is durably stored: quota must never be spent on a failed attempt.
 *
 * `providedChart` is the chart the requesting browser drew, present only on
 * the Analyze Now path. The scheduled run has no browser and always leaves
 * the pipeline to render its own.
 */
export async function processWatchlistItem(
  profileId: string,
  item: EnabledWatchlistItem,
  period: string,
  providedChart?: ProvidedChart | null,
): Promise<ProcessedItem | null> {
  const ref: InstrumentRef = {
    instrumentId: item.instrumentId,
    instrumentKey: item.instrumentKey,
    exchange: item.exchange,
    symbol: item.symbol,
    name: item.name,
  };

  const result = await runInstrumentAnalysis(
    profileId,
    ref,
    item.analysisLookbackDays,
    "watchlist_daily",
    providedChart,
  );

  if (!result) {
    await releaseDailyBriefingEntitlement(profileId, period);
    return null;
  }

  return {
    item,
    analysisId: result.analysisId,
    marketDataDate: result.marketDataDate,
    latestPrice: result.latestPrice,
    analysis: result.analysis,
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
  providedChart?: ProvidedChart | null,
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
  void processWatchlistItem(profileId, item, period, providedChart)
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
