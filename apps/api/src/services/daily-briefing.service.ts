import type { AnalysisResult } from "@chartanalyzer/shared";
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
import { sendEmail, type EmailAttachment } from "../lib/email/resend-client.js";
import { buildAnalysisPdfAttachment } from "./analysis-pdf.service.js";
import { logAppError } from "../lib/error-log.js";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";

const IST_OFFSET_MINUTES = 5.5 * 60;

function currentUtcPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Current hour (0-23) in IST, the timezone every schedule setting is in. */
function currentIstHour(): number {
  const istMs = Date.now() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).getUTCHours();
}

/** Current minute (0-59) in IST, alongside currentIstHour above. */
function currentIstMinute(): number {
  const istMs = Date.now() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).getUTCMinutes();
}

type EntitlementOutcome = "quota" | "credit" | "no_subscription" | "quota_exhausted";

/**
 * Which of the two Daily Briefing entitlements paid for a run: the
 * subscription's monthly allowance, or a one-off credit from a top-up pack.
 *
 * Every caller that consumes one owns a compensating release, and that release
 * MUST name the same source. Refunding the wrong one silently converts a
 * purchased credit into a quota refund (the user loses money) or a quota unit
 * into a minted credit (the user gains one) — neither errors, both corrupt the
 * balance. Exactly the hazard documented on analysis.service.ts's
 * releaseEntitlement.
 */
export type BriefingEntitlementSource = "quota" | "credit";

async function consumeDailyBriefingEntitlement(profileId: string): Promise<EntitlementOutcome> {
  return callRpc<EntitlementOutcome>("check_and_consume_daily_briefing_entitlement", {
    p_profile_id: profileId,
  });
}

/**
 * Compensating release for a Daily Briefing entitlement consumed but never
 * turned into a stored analysis (market-data fetch, chart render, or the AI
 * call failed). Same captured-period trade-offs as analysis.service.ts's
 * releaseEntitlement — see that function's doc comment for the full reasoning;
 * not re-derived here. The branch below carries the same hard requirement:
 * `source` must be what was actually spent.
 */
async function releaseDailyBriefingEntitlement(
  profileId: string,
  source: BriefingEntitlementSource,
  period: string,
): Promise<void> {
  try {
    if (source === "quota") {
      await callRpc<null>("decrement_daily_briefing_usage", {
        p_profile_id: profileId,
        p_period: period,
      });
    } else {
      // Credits are not period-scoped, so no period is passed — there is no
      // month-boundary race to guard against.
      await callRpc<null>("refund_daily_briefing_credit", {
        p_profile_id: profileId,
      });
    }
  } catch (cause) {
    // Logged, never rethrown: this runs on the failure path of work that has
    // already gone wrong, and a failed refund must not replace the original
    // error with its own.
    logger.error("failed to release daily briefing entitlement", {
      profileId,
      source,
      period,
      cause: String(cause),
    });
  }
}

/**
 * Renders one PDF per analysed symbol, for attaching to the briefing email.
 *
 * One document per symbol rather than a single combined file: each is a
 * self-contained analysis the reader can file, forward or open on its own, and
 * it is byte-for-byte the same document History's Download button produces.
 *
 * Failures are dropped, never thrown. buildAnalysisPdfAttachment already
 * returns null for anything that goes wrong, and the email is worth sending
 * with fewer attachments — or none — rather than not at all.
 */
async function buildBriefingAttachments(analysisIds: string[]): Promise<EmailAttachment[]> {
  const built = await Promise.all(analysisIds.map((id) => buildAnalysisPdfAttachment(id)));
  return built.filter((attachment): attachment is EmailAttachment => attachment !== null);
}

/**
 * Stamps the analyses that just went out in an email, so History can say which
 * results reached the user's inbox and which only ever sat in the app.
 *
 * Called strictly AFTER a successful send: the column records that an email
 * left, not that one was attempted. Failures are logged and swallowed — the
 * mail is already delivered, and an unstamped row is a cosmetic loss, whereas
 * throwing here would turn a sent briefing into a failed one.
 */
async function markAnalysesEmailed(analysisIds: string[]): Promise<void> {
  if (analysisIds.length === 0) return;

  const { error } = await supabaseAdmin
    .from("analyses")
    .update({ emailed_at: new Date().toISOString() })
    .in("id", analysisIds);

  if (error) {
    logger.error("failed to stamp analyses as emailed", {
      analysisIds,
      cause: String(error),
    });
  }
}

interface ProcessedItem {
  item: EnabledWatchlistItem;
  analysisId: string;
  marketDataDate: string;
  latestPrice: number;
  analysis: AnalysisResult;
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
  source: BriefingEntitlementSource,
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
    await releaseDailyBriefingEntitlement(profileId, source, period);
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

/**
 * How many watchlist items are analysed at once. Kept deliberately small: each
 * one is a model call and an upstream market-data fetch, and the point is to
 * stop a long watchlist overrunning its scheduled hour, not to fan out as hard
 * as the providers will tolerate.
 */
const BRIEFING_CONCURRENCY = 3;

/**
 * Runs `run` over `items` with at most `limit` in flight, returning results in
 * the ORDER OF THE INPUT rather than the order they finished.
 *
 * `run` is expected not to reject — processWatchlistItem returns null for
 * failure — so there is no per-item error handling here; a rejection would
 * propagate out of the whole batch, which is the same thing an unguarded
 * sequential loop did.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  // Each worker pulls the next index and runs it. Reading and advancing the
  // cursor happens with no await between them, so the workers cannot be handed
  // the same index.
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await run(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));

  return results;
}

export async function runDailyBriefingForUser(
  profileId: string,
  runHourIst?: number,
  runMinuteIst?: number,
): Promise<void> {
  const briefingDate = todayIsoDate();
  // The log row is keyed by (profile, date, hour, minute), so the idempotency
  // guard is per scheduled slot now that symbols can be scheduled at
  // different hours and minutes. An ops manual trigger (no hour) is logged
  // against the current IST hour/minute.
  const logHourIst = runHourIst ?? currentIstHour();
  const logMinuteIst = runHourIst === undefined ? currentIstMinute() : (runMinuteIst ?? 0);

  /**
   * Updates this run's own daily_briefing_log row.
   *
   * The (profile, date, hour, minute) tuple is applied here rather than
   * spelled out at each of the six call sites below: one of them previously
   * omitted the hour and so rewrote the status of every other hour's
   * briefing for the same user and day. A single place to key the row makes
   * that omission unexpressible.
   */
  const markLog = async (
    status: string,
    counts?: { symbols_sent?: number; symbols_failed?: number },
  ): Promise<void> => {
    const { error } = await supabaseAdmin
      .from("daily_briefing_log")
      .update({ status, ...counts, updated_at: new Date().toISOString() })
      .eq("profile_id", profileId)
      .eq("briefing_date", briefingDate)
      .eq("run_hour_ist", logHourIst)
      .eq("run_minute_ist", logMinuteIst);
    if (error) {
      logger.error("failed to update daily_briefing_log row", {
        profileId,
        status,
        cause: String(error),
      });
    }
  };

  const { error: logInsertError } = await supabaseAdmin.from("daily_briefing_log").insert({
    profile_id: profileId,
    briefing_date: briefingDate,
    run_hour_ist: logHourIst,
    run_minute_ist: logMinuteIst,
    status: "processing",
  });

  if (logInsertError) {
    // Unique-violation on (profile_id, briefing_date, run_hour_ist,
    // run_minute_ist) means this slot's briefing already ran (or is
    // currently running) for this user — the idempotency guard doing exactly
    // its job. Any other error is unexpected and logged, but this run still
    // stops rather than risk a duplicate email.
    if (logInsertError.code !== "23505") {
      logger.error("failed to write daily_briefing_log row", {
        profileId,
        cause: String(logInsertError),
      });
    }
    return;
  }

  try {
    const items = await getEnabledWatchlistItems(profileId, runHourIst, runMinuteIst);
    if (items.length === 0) {
      await markLog("skipped_no_symbols");
      return;
    }

    const period = currentUtcPeriod();
    const succeeded: BriefingItem[] = [];
    const failed: FailedBriefingItem[] = [];

    // Phase 1 — admission, strictly sequential. Entitlement is consumed one unit
    // per item before any work starts, exactly as it was when the whole loop was
    // sequential: the concurrency added below must never be able to consume more
    // units than the user has, or to race two items against the same last unit.
    // These are cheap RPC calls, so serialising them costs nothing worth saving.
    //
    // Each admission records WHICH entitlement paid for it, because a failure
    // later has to give back that same one.
    const admitted: { item: EnabledWatchlistItem; source: BriefingEntitlementSource }[] = [];
    for (const item of items) {
      const outcome = await consumeDailyBriefingEntitlement(profileId);
      if (outcome === "no_subscription") {
        // No Daily Briefing entitlement at all — no live subscription and no
        // top-up credits: stop immediately, no market-data/AI calls for any
        // symbol, no email. Distinct terminal status from
        // 'skipped_quota_exhausted' for observability.
        await markLog("skipped_no_entitlement");
        return;
      }
      if (outcome === "quota_exhausted") break;

      admitted.push({ item, source: outcome });
    }

    // Phase 2 — the expensive part, a few at a time. Each item is a full pipeline
    // (market data, chart render, model call) at roughly a minute each, so a ten
    // symbol watchlist used to take the better part of ten minutes inside a single
    // hourly tick, pushing later users' briefings well past the hour they asked
    // for. Each item still releases its own entitlement on failure, inside
    // processWatchlistItem, so failure handling is unchanged by running them
    // alongside each other.
    const outcomes = await mapWithConcurrency(admitted, BRIEFING_CONCURRENCY, ({ item, source }) =>
      processWatchlistItem(profileId, item, source, period),
    );

    // Results are folded back in watchlist order, not completion order, so the
    // email lists symbols in the order the user arranged them.
    const succeededAnalysisIds: string[] = [];
    admitted.forEach(({ item }, index) => {
      const processed = outcomes[index];
      if (processed) {
        succeededAnalysisIds.push(processed.analysisId);
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
    });

    if (succeeded.length === 0 && failed.length === 0) {
      // Every item was skipped because quota ran out before any could even be
      // attempted (e.g. a user with zero remaining quota this period).
      await markLog("skipped_quota_exhausted");
      return;
    }

    if (succeeded.length === 0) {
      // Every attempted symbol failed; nothing worth emailing.
      await markLog("failed", { symbols_failed: failed.length });
      await logAppError(profileId, "briefing", "Every symbol in this scheduled briefing failed", {
        briefingDate,
        failed: failed.map((item) => item.symbol),
      });
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
      await markLog("failed");
      await logAppError(
        profileId,
        "briefing",
        "Could not load your profile to send the briefing email",
        {
          briefingDate,
        },
      );
      return;
    }

    const { subject, html } = buildDailyBriefingEmail(briefingDate, succeeded, failed);
    const attachments = await buildBriefingAttachments(succeededAnalysisIds);

    try {
      await sendEmail({ to: profile.email, subject, html, attachments });
    } catch (cause) {
      logger.error("failed to send daily briefing email", {
        profileId,
        cause: String(cause),
      });
      await markLog("failed", {
        symbols_sent: succeeded.length,
        symbols_failed: failed.length,
      });
      await logAppError(
        profileId,
        "briefing",
        "Briefing was generated but the email failed to send",
        {
          briefingDate,
          symbolsSent: succeeded.length,
          symbolsFailed: failed.length,
        },
      );
      return;
    }

    await markAnalysesEmailed(succeededAnalysisIds);

    await markLog(failed.length > 0 ? "sent_partial" : "sent", {
      symbols_sent: succeeded.length,
      symbols_failed: failed.length,
    });
  } catch (cause) {
    logger.error("daily briefing processing failed unexpectedly", {
      profileId,
      cause: String(cause),
    });
    await markLog("failed");
    await logAppError(
      profileId,
      "briefing",
      "The daily briefing was interrupted and could not be completed",
      {
        briefingDate,
        cause: String(cause),
      },
    );
  }
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
 * Window after which a `watchlist_analysis_runs` row still at 'processing' is
 * considered stranded rather than genuinely in flight. Matches
 * STRANDED_AFTER_MS in ai-analysis.service.ts — this pipeline is bounded by
 * the same model-call/backoff/storage budget.
 */
const STRANDED_RUN_AFTER_MS = 10 * 60_000;

/** Upper bound on rows settled per sweep, for the same reason as MAX_RECLAIM_BATCH. */
const MAX_RECLAIM_RUN_BATCH = 20;

/** Scheduled briefing logs have the same bounded pipeline as on-demand runs. */
export const STRANDED_DAILY_BRIEFING_AFTER_MS = 10 * 60_000;
const MAX_RECLAIM_DAILY_BRIEFING_BATCH = 20;

/**
 * Recovers "Analyze Now" runs left at 'processing' by a process restart.
 *
 * runWatchlistItemNow writes the row before starting processWatchlistItem in
 * the background (see its doc comment) and relies on that promise's
 * .then/.catch to call settleRun. If the process dies or restarts mid-run,
 * that callback never fires and the row — and the client polling it — is
 * stuck at 'processing' forever. There is no way to safely resume from here
 * (the row does not record which entitlement source/period paid for it, so
 * it cannot be refunded the way a stranded fundamentals analysis is), so this
 * only unblocks the client by marking the run failed.
 *
 * Sequential and bounded, and never throws — it is called from a timer.
 */
export async function reclaimStrandedWatchlistRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STRANDED_RUN_AFTER_MS).toISOString();

  // Served by watchlist_analysis_runs_profile_created_idx.
  const { data, error } = await supabaseAdmin
    .from("watchlist_analysis_runs")
    .select("id, profile_id, watchlist_item_id, created_at")
    .eq("status", "processing")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_RECLAIM_RUN_BATCH)
    .returns<{ id: string; profile_id: string; watchlist_item_id: string; created_at: string }[]>();

  if (error) {
    logger.error("stranded watchlist run sweep query failed", { cause: String(error) });
    return 0;
  }

  const rows = data ?? [];
  if (rows.length === 0) return 0;

  logger.info("reclaiming stranded watchlist analysis runs", { count: rows.length });

  for (const row of rows) {
    const { error: markError } = await supabaseAdmin
      .from("watchlist_analysis_runs")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      // Only if it is still processing: the pipeline may have settled it
      // between the query above and this write.
      .eq("status", "processing");
    if (markError) {
      logger.error("failed to mark stranded watchlist run as failed", {
        runId: row.id,
        cause: String(markError),
      });
      continue;
    }
    // Same reasoning as the analogous stranded-analysis case: nothing was
    // running when this happened, so no request of the user's ever returned
    // an error for it.
    await logAppError(
      row.profile_id,
      "watchlist_run",
      "The analysis was interrupted and could not be completed",
      { runId: row.id, watchlistItemId: row.watchlist_item_id },
    );
  }

  return rows.length;
}

/**
 * Marks scheduled briefing logs stranded by a process restart as failed. The
 * conditional status predicate prevents a run that settled during the query
 * from being overwritten.
 */
export async function reclaimStrandedDailyBriefingLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - STRANDED_DAILY_BRIEFING_AFTER_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("daily_briefing_log")
    .select("id, profile_id, briefing_date, run_hour_ist, run_minute_ist, created_at")
    .eq("status", "processing")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_RECLAIM_DAILY_BRIEFING_BATCH)
    .returns<
      {
        id: string;
        profile_id: string;
        briefing_date: string;
        run_hour_ist: number;
        run_minute_ist: number;
        created_at: string;
      }[]
    >();

  if (error) {
    logger.error("stranded daily briefing sweep query failed", { cause: String(error) });
    return 0;
  }

  const rows = data ?? [];
  if (rows.length === 0) return 0;

  logger.info("reclaiming stranded daily briefing logs", { count: rows.length });
  for (const row of rows) {
    const { error: markError } = await supabaseAdmin
      .from("daily_briefing_log")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "processing");
    if (markError) {
      logger.error("failed to mark stranded daily briefing as failed", {
        briefingLogId: row.id,
        cause: String(markError),
      });
      continue;
    }
    await logAppError(
      row.profile_id,
      "briefing",
      "The daily briefing was interrupted and could not be completed",
      {
        briefingLogId: row.id,
        briefingDate: row.briefing_date,
        runHourIst: row.run_hour_ist,
        runMinuteIst: row.run_minute_ist,
      },
    );
  }

  return rows.length;
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
async function runWatchlistItemNow(
  profileId: string,
  watchlistItemId: string,
  force: boolean,
  providedChart: ProvidedChart | null,
  emailResult: boolean,
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
  const source: BriefingEntitlementSource = outcome;

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
    await releaseDailyBriefingEntitlement(profileId, source, period);
    throw new Error("Could not start analysis");
  }

  // Deliberately not awaited: see the doc comment above. Failures are
  // already logged and compensated (quota release) inside
  // processWatchlistItem itself; settling the run row here is what turns
  // that into something the user can see after a reload.
  void processWatchlistItem(profileId, item, source, period, providedChart)
    .then(async (processed) => {
      await settleRun(runRow.id, processed ? "complete" : "failed", processed?.analysisId ?? null);
      // Emailed only after the run is settled, and only on the Brief Now path.
      // A failed run has nothing to report and has already refunded its
      // entitlement, so there is nothing to send.
      if (emailResult && processed) {
        await sendSingleItemBriefing(profileId, processed);
      } else if (!processed) {
        await logAppError(profileId, "watchlist_run", "This run could not produce an analysis", {
          watchlistItemId,
          mode: emailResult ? "brief" : "analyze",
        });
      }
    })
    .catch(async (cause: unknown) => {
      logger.error("watchlist analyze-now background processing failed", {
        profileId,
        watchlistItemId,
        cause: String(cause),
      });
      await settleRun(runRow.id, "failed", null);
      await logAppError(profileId, "watchlist_run", "This run failed unexpectedly", {
        watchlistItemId,
        mode: emailResult ? "brief" : "analyze",
        cause: String(cause),
      });
    });

  return { ok: true, runId: runRow.id, instrumentId: item.instrumentId, startedAt };
}

/**
 * "Analyze Now" — runs the item and leaves the result in History. No email.
 */
export async function analyzeWatchlistItemNow(
  profileId: string,
  watchlistItemId: string,
  force = false,
  providedChart?: ProvidedChart | null,
): Promise<AnalyzeNowResult> {
  return runWatchlistItemNow(profileId, watchlistItemId, force, providedChart ?? null, false);
}

/**
 * "Brief Now" — the same run, plus the briefing email for that one symbol with
 * its analysis attached as a PDF.
 *
 * Identical in every other respect to Analyze Now, deliberately: same
 * entitlement (Daily Briefing quota, then a top-up credit), same duplicate
 * warning, same pipeline, same run row. The email is the only difference, so
 * it is the only thing this wrapper adds.
 *
 * Like Analyze Now it does not touch daily_briefing_log: that table's unique
 * (profile, date, hour) key is the scheduled digest's idempotency guard, and
 * an on-demand brief writing into it would make the day's real briefing look
 * as though it had already been sent.
 */
export async function briefWatchlistItemNow(
  profileId: string,
  watchlistItemId: string,
  force = false,
  providedChart?: ProvidedChart | null,
): Promise<AnalyzeNowResult> {
  return runWatchlistItemNow(profileId, watchlistItemId, force, providedChart ?? null, true);
}

/**
 * Sends the one-symbol briefing email for a Brief Now run.
 *
 * Reuses buildDailyBriefingEmail with a single-item list rather than
 * introducing a second template: the reader is getting the same content the
 * digest would have carried for this symbol, just sooner, and a divergent
 * layout would make the two look like different products.
 *
 * Never throws. The analysis is already stored and visible in History, so a
 * mail failure is logged and left there — it must not turn a completed run
 * into a failed one.
 */
async function sendSingleItemBriefing(profileId: string, processed: ProcessedItem): Promise<void> {
  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("id", profileId)
      .single<{ email: string }>();

    if (profileError || !profile) {
      throw profileError ?? new Error("Profile has no email");
    }

    const item: BriefingItem = {
      symbol: processed.item.symbol,
      name: processed.item.name,
      marketDataDate: processed.marketDataDate,
      latestPrice: processed.latestPrice,
      analysis: processed.analysis,
    };

    const { subject, html } = buildDailyBriefingEmail(todayIsoDate(), [item], []);
    const attachments = await buildBriefingAttachments([processed.analysisId]);

    await sendEmail({ to: profile.email, subject, html, attachments });
    await markAnalysesEmailed([processed.analysisId]);
  } catch (cause) {
    logger.error("failed to send brief-now email", { profileId, cause: String(cause) });
  }
}

/**
 * Entry point for both the scheduler and the internal manual-trigger route.
 * Iterates every profile with at least one daily-analysis-enabled watchlist
 * item; one profile's failure never aborts the run for the rest.
 */
export async function runDailyBriefingForAllUsers(
  runHourIst?: number,
  runMinuteIst?: number,
): Promise<void> {
  const profileIds = await listProfilesWithEnabledWatchlist(runHourIst, runMinuteIst);
  logger.info("daily briefing run starting", {
    profileCount: profileIds.length,
    runHourIst: runHourIst ?? "all",
    runMinuteIst: runHourIst === undefined ? "all" : (runMinuteIst ?? 0),
  });

  for (const profileId of profileIds) {
    try {
      await runDailyBriefingForUser(profileId, runHourIst, runMinuteIst);
    } catch (cause) {
      logger.error("daily briefing run failed for profile", {
        profileId,
        cause: String(cause),
      });
    }
  }

  logger.info("daily briefing run complete", { profileCount: profileIds.length });
}
