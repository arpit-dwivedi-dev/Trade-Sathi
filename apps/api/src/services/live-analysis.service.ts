import {
  consumeAnalysisEntitlement,
  currentUtcPeriod,
  releaseEntitlement,
} from "./analysis.service.js";
import { runInstrumentAnalysis, type ProvidedChart } from "./instrument-analysis.service.js";
import { fetchInstrumentById } from "./market-chart.service.js";
import { logger } from "../lib/logger.js";

/**
 * "Analyze this chart" from the live chart view: any instrument the user can
 * search for, over whatever window they are currently looking at, with no
 * watchlist entry required.
 *
 * Spends the ordinary manual-analysis entitlement (the same monthly quota /
 * credit an uploaded screenshot costs), NOT the Daily Briefing subscription:
 * this is a one-off the user asked for, not scheduled work. Everything after
 * the entitlement is the shared pipeline in instrument-analysis.service.
 */

export type LiveAnalysisResult =
  | { ok: true; instrumentId: string; startedAt: string }
  | { ok: false; reason: "not_found" | "invalid_lookback" | "quota_exceeded" };

const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;

/**
 * Deliberately asynchronous, for the same reason analyzeWatchlistItemNow is:
 * the pipeline (market data + chart render + AI call) routinely takes 20-30+
 * seconds, past the idle timeout of proxies a mobile client may sit behind.
 * Only the fast checks (instrument lookup, entitlement) happen before this
 * returns; the pipeline then runs in the background and persists its own
 * `analyses` row. The client polls for a source='live' row on this instrument
 * newer than `startedAt`, which it can read directly under RLS.
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

  // Captured before the RPC and reused by the compensating release below —
  // see releaseEntitlement's doc comment for the month-boundary trade-off.
  const period = currentUtcPeriod();
  const entitlementSource = await consumeAnalysisEntitlement(profileId);
  if (!entitlementSource) return { ok: false, reason: "quota_exceeded" };

  const startedAt = new Date().toISOString();

  // Not awaited: see the doc comment above. A null result means the pipeline
  // failed before storing anything, so the entitlement is given back here —
  // the pipeline itself deliberately owns no quota policy.
  void runInstrumentAnalysis(profileId, ref, lookbackDays, "live", providedChart)
    .then(async (result) => {
      if (!result) await releaseEntitlement(profileId, entitlementSource, period);
    })
    .catch(async (cause: unknown) => {
      logger.error("live analysis background processing failed", {
        profileId,
        instrumentId,
        cause: String(cause),
      });
      await releaseEntitlement(profileId, entitlementSource, period);
    });

  return { ok: true, instrumentId: ref.instrumentId, startedAt };
}
