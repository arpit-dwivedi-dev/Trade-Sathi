import { consumeAnalysisCredit, refundAnalysisCredit } from "./analysis.service.js";
import { runInstrumentAnalysis, type ProvidedChart } from "./instrument-analysis.service.js";
import { fetchInstrumentById } from "./market-chart.service.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * "Analyze this chart" from the live chart view: any instrument the user can
 * search for, over whatever window they are currently looking at, with no
 * watchlist entry required.
 *
 * Spends the ordinary chart_analysis credit (the same one an uploaded
 * screenshot costs), NOT the daily_briefing_run credit: this is a one-off
 * the user asked for, not scheduled work. Everything after the credit is the
 * shared pipeline in instrument-analysis.service.
 */

export type LiveAnalysisResult =
  | { ok: true; analysisId: string; instrumentId: string; startedAt: string }
  | { ok: false; reason: "not_found" | "invalid_lookback" | "insufficient_credits" };

const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;

/**
 * Deliberately asynchronous, for the same reason analyzeWatchlistItemNow is:
 * the pipeline (market data + chart render + AI call) routinely takes 20-30+
 * seconds, past the idle timeout of proxies a mobile client may sit behind.
 * Only the fast checks (instrument lookup, entitlement, row creation) happen
 * before this returns; the pipeline then runs in the background and fills in
 * the row.
 *
 * The 'queued' row is written BEFORE the pipeline starts, and its id is what
 * the client watches — exactly as the manual upload path does. It previously
 * returned only a timestamp, and the client hunted for "any source='live' row
 * on this instrument newer than startedAt", which was wrong twice over: a run
 * that failed wrote no row at all, so the browser sat on a spinner until its
 * own three-minute timeout for a failure known in seconds; and the comparison
 * was between a clock on this host and a timestamp written by the database's,
 * so any skew between them hid a perfectly good result.
 */
export async function analyzeInstrumentLive(
  profileId: string,
  instrumentId: string,
  lookbackDays: number,
  providedChart?: ProvidedChart | null,
): Promise<LiveAnalysisResult> {
  if (
    !Number.isInteger(lookbackDays) ||
    lookbackDays < MIN_LOOKBACK_DAYS ||
    lookbackDays > MAX_LOOKBACK_DAYS
  ) {
    return { ok: false, reason: "invalid_lookback" };
  }

  const ref = await fetchInstrumentById(instrumentId);
  if (!ref) return { ok: false, reason: "not_found" };

  const consumed = await consumeAnalysisCredit(profileId);
  if (!consumed) return { ok: false, reason: "insufficient_credits" };

  const startedAt = new Date().toISOString();

  // The row the client will watch. image_key, model_id and prompt_version are
  // placeholders satisfying their NOT NULL constraints until the pipeline has
  // real values for them — the same placeholders the manual upload path uses.
  const { data: queuedRow, error: queueError } = await supabaseAdmin
    .from("analyses")
    .insert({
      profile_id: profileId,
      // source_type is a placeholder required by its NOT NULL constraint;
      // `source` is the authoritative provenance for a generated chart.
      source_type: "upload",
      source: "live",
      instrument_id: ref.instrumentId,
      symbol: ref.symbol,
      image_key: "",
      model_id: "unassigned",
      prompt_version: "unassigned",
      status: "queued",
      analysis_lookback_days: lookbackDays,
    })
    .select("id")
    .single<{ id: string }>();

  if (queueError || !queuedRow) {
    // Nothing was started, so the credit consumed above buys nothing.
    logger.error("failed to record live analysis run", {
      profileId,
      instrumentId,
      cause: String(queueError),
    });
    await refundAnalysisCredit(profileId);
    throw queueError ?? new Error("Live analysis insert returned no row");
  }

  // Not awaited: see the doc comment above. A null result means the pipeline
  // failed before storing a result — it has already marked the row 'failed',
  // and the credit is given back here, since the pipeline itself
  // deliberately owns no billing policy.
  void runInstrumentAnalysis(
    profileId,
    ref,
    lookbackDays,
    "live",
    providedChart,
    queuedRow.id,
  )
    .then(async (result) => {
      if (!result) await refundAnalysisCredit(profileId, queuedRow.id);
    })
    .catch(async (cause: unknown) => {
      logger.error("live analysis background processing failed", {
        profileId,
        instrumentId,
        cause: String(cause),
      });
      // The pipeline throwing outright bypasses its own failure marking, so
      // the row would otherwise sit at 'queued' until the stranded sweeper
      // found it — with the client watching a spinner the whole time.
      await supabaseAdmin
        .from("analyses")
        .update({
          status: "failed",
          error_code: "api_error",
          error_message: "The analysis could not be completed",
        })
        .eq("id", queuedRow.id);
      await refundAnalysisCredit(profileId, queuedRow.id);
    });

  return { ok: true, analysisId: queuedRow.id, instrumentId: ref.instrumentId, startedAt };
}
