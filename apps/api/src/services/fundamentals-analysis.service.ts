import type { InstrumentFundamentals } from "@chartanalyzer/shared";
import {
  AnalysisFailure,
  FUNDAMENTALS_PROMPT_VERSION,
  runFundamentalsAnalysis,
} from "./ai-analysis.service.js";
import { currentUtcPeriod } from "./analysis.service.js";
import {
  fetchInstrumentById,
  getFundamentalsForInstrument,
  type InstrumentRef,
} from "./market-chart.service.js";
import { MarketDataError } from "../lib/market-data/types.js";
import { logAppError } from "../lib/error-log.js";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";

/**
 * "Analyze with AI" from the Fundamentals tab: reads the InstrumentFundamentals
 * payload the tab already fetched and turns it into a stored verdict, reusing
 * the analyses table (Realtime, History, the stranded sweeper) and the
 * provider-chain machinery in ai-analysis.service.ts.
 *
 * Deliberately its own entitlement pool (fundamentals_usage_counters, see
 * the migration), not the manual chart-analysis quota/credit: pricing for
 * this feature is not decided yet, so it is kept separate rather than
 * borrowed from a pool it may not end up billed the same as.
 */

export type TriggerFundamentalsResult =
  | { ok: true; analysisId: string; instrumentId: string; startedAt: string }
  | { ok: false; reason: "not_found" | "quota_exceeded" };

/** Consumes one unit of the fundamentals-analysis quota. See the migration's
 *  check_and_consume_fundamentals_entitlement for the row-locked increment. */
async function consumeFundamentalsEntitlement(profileId: string): Promise<boolean> {
  return callRpc<boolean>("check_and_consume_fundamentals_entitlement", {
    p_profile_id: profileId,
  });
}

/** The compensating release for a consumed-but-unusable unit — mirrors
 *  releaseEntitlement in analysis.service.ts for the manual quota. */
async function releaseFundamentalsEntitlement(
  profileId: string,
  period: string,
): Promise<void> {
  await callRpc<null>("decrement_fundamentals_usage", {
    p_profile_id: profileId,
    p_period: period,
  });
}

/**
 * An in-flight run for this profile and instrument, if one exists — the
 * duplicate-request guard. A double click, a second tab, or a retried request
 * while the first is still `queued` must not spend a second entitlement unit
 * and start a redundant model call; it should just hand back the run already
 * in progress, the same way the client would learn about it from Realtime.
 *
 * Only 'queued' rows qualify: a 'complete' or 'failed' row is a finished
 * attempt, and the user asking again should get a fresh one.
 */
async function findInFlightFundamentalsAnalysis(
  profileId: string,
  instrumentId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("analyses")
    .select("id")
    .eq("profile_id", profileId)
    .eq("instrument_id", instrumentId)
    .eq("source", "fundamentals")
    .eq("status", "queued")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    logger.error("fundamentals in-flight lookup failed", {
      profileId,
      instrumentId,
      cause: String(error),
    });
    return null;
  }

  return data?.id ?? null;
}

/**
 * Starts a fundamentals analysis. Deliberately asynchronous, for the same
 * reason the live-chart and watchlist pipelines are: the fundamentals fetch
 * plus the AI call routinely takes several seconds to tens of seconds, past
 * what a mobile client's proxy will hold a request open for. Only the fast
 * checks (instrument lookup, the in-flight guard, entitlement, row creation)
 * happen before this returns; the pipeline then runs in the background and
 * fills in the row the caller is handed.
 */
export async function triggerFundamentalsAnalysis(
  profileId: string,
  instrumentId: string,
): Promise<TriggerFundamentalsResult> {
  const ref = await fetchInstrumentById(instrumentId);
  if (!ref) return { ok: false, reason: "not_found" };

  const inFlightId = await findInFlightFundamentalsAnalysis(profileId, ref.instrumentId);
  if (inFlightId) {
    return {
      ok: true,
      analysisId: inFlightId,
      instrumentId: ref.instrumentId,
      startedAt: new Date().toISOString(),
    };
  }

  // Captured before the RPC and reused by the compensating release below —
  // see releaseEntitlement's doc comment in analysis.service.ts for the
  // month-boundary trade-off this shares.
  const period = currentUtcPeriod();
  const allowed = await consumeFundamentalsEntitlement(profileId);
  if (!allowed) return { ok: false, reason: "quota_exceeded" };

  const startedAt = new Date().toISOString();

  // The row the client will watch. image_key, model_id and prompt_version are
  // placeholders satisfying their NOT NULL constraints until the pipeline has
  // real values — the same placeholders every other analyses-row writer uses.
  const { data: queuedRow, error: queueError } = await supabaseAdmin
    .from("analyses")
    .insert({
      profile_id: profileId,
      // source_type is a placeholder required by its NOT NULL constraint;
      // `source` is the authoritative provenance for a fundamentals read.
      source_type: "upload",
      source: "fundamentals",
      instrument_id: ref.instrumentId,
      symbol: ref.symbol,
      image_key: "",
      model_id: "unassigned",
      prompt_version: "unassigned",
      status: "queued",
    })
    .select("id")
    .single<{ id: string }>();

  if (queueError || !queuedRow) {
    logger.error("failed to record fundamentals analysis run", {
      profileId,
      instrumentId,
      cause: String(queueError),
    });
    await releaseFundamentalsEntitlement(profileId, period);
    throw queueError ?? new Error("Fundamentals analysis insert returned no row");
  }

  // Not awaited: see the doc comment above. A false result means the pipeline
  // failed before storing a result — it has already marked the row 'failed',
  // and the entitlement is given back here, since the pipeline itself
  // deliberately owns no quota policy.
  void runFundamentalsAnalysisPipeline(profileId, ref, queuedRow.id)
    .then(async (succeeded) => {
      if (!succeeded) await releaseFundamentalsEntitlement(profileId, period);
    })
    .catch(async (cause: unknown) => {
      logger.error("fundamentals analysis background processing failed", {
        profileId,
        instrumentId,
        cause: String(cause),
      });
      // The pipeline throwing outright bypasses its own failure marking, so
      // the row would otherwise sit at 'queued' until the stranded sweeper
      // found it, with the client watching a spinner the whole time.
      await supabaseAdmin
        .from("analyses")
        .update({
          status: "failed",
          error_code: "api_error",
          error_message: "The analysis could not be completed",
        })
        .eq("id", queuedRow.id);
      await releaseFundamentalsEntitlement(profileId, period);
    });

  return { ok: true, analysisId: queuedRow.id, instrumentId: ref.instrumentId, startedAt };
}

/**
 * Fetches fundamentals, runs the AI call, and writes the result. Returns
 * whether it succeeded, having already logged and marked the row on any
 * failure — the caller is responsible for giving back the entitlement it
 * spent when this returns false.
 */
async function runFundamentalsAnalysisPipeline(
  profileId: string,
  ref: InstrumentRef,
  analysisId: string,
): Promise<boolean> {
  /**
   * Records a terminal failure on the pre-created row, so a client watching it
   * learns in seconds that this run is over, and writes the app_error_logs
   * row the Logs tab reads — this is the one failure the user has no other
   * way to learn about, since nothing they did returned an error directly.
   * Best-effort and never throws.
   */
  const markFailed = async (code: string, message: string): Promise<void> => {
    await logAppError(profileId, "fundamentals_analysis", message, {
      analysisId,
      errorCode: code,
      instrumentKey: ref.instrumentKey,
    });
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({ status: "failed", error_code: code, error_message: message })
      .eq("id", analysisId);
    if (error) {
      logger.error("failed to mark fundamentals analysis as failed", {
        analysisId,
        cause: String(error),
      });
    }
  };

  logger.info("fundamentals analysis started", {
    analysisId,
    instrumentKey: ref.instrumentKey,
  });

  let providerFundamentals;
  try {
    providerFundamentals = await getFundamentalsForInstrument(ref);
  } catch (cause) {
    logger.error("fundamentals data fetch failed", {
      profileId,
      instrumentKey: ref.instrumentKey,
      reason: cause instanceof MarketDataError ? cause.reason : "unknown",
      cause: String(cause),
    });
    await markFailed(
      "market_data_unavailable",
      "Fundamentals data for this instrument could not be loaded",
    );
    return false;
  }

  // The provider only ever saw a ticker; the instrument identity this route
  // resolved is what fills in the `instrument` block — same composition the
  // GET /api/market/fundamentals route does.
  const payload: InstrumentFundamentals = {
    instrument: { id: ref.instrumentId, symbol: ref.symbol, name: ref.name, exchange: ref.exchange },
    ...providerFundamentals,
  };

  let outcome;
  try {
    outcome = await runFundamentalsAnalysis(payload);
  } catch (cause) {
    logger.error("fundamentals AI analysis failed", {
      profileId,
      instrumentKey: ref.instrumentKey,
      errorCode: cause instanceof AnalysisFailure ? cause.code : "unknown",
      cause: String(cause),
    });
    await markFailed(
      cause instanceof AnalysisFailure ? cause.code : "api_error",
      cause instanceof AnalysisFailure ? cause.message : "The analysis could not be completed",
    );
    return false;
  }

  const { error: updateError } = await supabaseAdmin
    .from("analyses")
    .update({
      fundamentals_result: outcome.result,
      fundamentals_stance: outcome.result.executive_verdict.stance,
      symbol: ref.symbol,
      summary: outcome.result.summary,
      model_id: outcome.modelId,
      prompt_version: FUNDAMENTALS_PROMPT_VERSION,
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      cost_usd: outcome.costUsd,
      latency_ms: outcome.latencyMs,
      status: "complete",
      error_code: null,
      error_message: null,
    })
    .eq("id", analysisId);

  if (updateError) {
    logger.error("failed to persist fundamentals analysis", {
      profileId,
      instrumentKey: ref.instrumentKey,
      cause: String(updateError),
    });
    await markFailed("api_error", "The analysis result could not be saved");
    return false;
  }

  logger.info("fundamentals analysis complete", { analysisId, latencyMs: outcome.latencyMs });
  return true;
}
