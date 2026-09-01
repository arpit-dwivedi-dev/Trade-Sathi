import { renderCandlestickChart } from "./chart-image.service.js";
import { runVisualAnalysis, AnalysisFailure } from "./ai-analysis.service.js";
import type { AnalysisAiResult } from "./ai-analysis.service.js";
import {
  MAX_CANDLES_FOR_CHART,
  getCandlesForInstrument,
  type InstrumentRef,
} from "./market-chart.service.js";
import { MarketDataError } from "../lib/market-data/types.js";
import { extensionForMimeType } from "../middleware/image-upload.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * The one pipeline that turns an instrument + a lookback window into a stored
 * analysis: market data -> chart image -> the SAME visual AI call manual
 * uploads use -> an `analyses` row.
 *
 * The chart image is normally rendered by the browser that asked for the
 * analysis (see `providedChart`), so the model reads exactly the chart the
 * user is looking at. Server-side rendering remains the fallback and is the
 * only option for the scheduled daily briefing, which has no browser.
 *
 * Deliberately knows nothing about entitlements. Every caller consumes its own
 * kind of quota before calling and compensates on a null return — the
 * scheduled/watchlist path spends the Daily Briefing entitlement, the live
 * path spends the manual analysis entitlement. Keeping that out of here is
 * what lets both share this code without either one's quota rules leaking
 * into the other.
 */

const BUCKET = "chart-images";

/** Provenance of a generated-chart analysis, mirroring the analysis_source enum. */
export type GeneratedAnalysisSource = "watchlist_daily" | "live";

/**
 * A chart image the caller already has — in practice the one the requesting
 * browser drew from the same candles, posted alongside the request.
 */
export interface ProvidedChart {
  buffer: Buffer;
  mimetype: string;
}

export interface InstrumentAnalysisResult {
  analysisId: string;
  marketDataDate: string;
  latestPrice: number;
  analysis: AnalysisAiResult;
}

/**
 * Stores a generated chart so the user can see the exact image the analysis
 * was read from, the same way they can for an uploaded screenshot.
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
async function storeGeneratedChart(
  imageKey: string,
  chart: ProvidedChart,
): Promise<void> {
  // upsert: the scheduled job and an Analyze Now run on the same instrument
  // and the same market-data date derive the identical key. Without this the
  // second one fails on a duplicate object for what is genuinely the same
  // chart.
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(imageKey, chart.buffer, { contentType: chart.mimetype, upsert: true });

  if (error) {
    logger.error("generated chart image upload failed", {
      imageKey,
      cause: String(error),
    });
  }
}

/**
 * The image key for a run. Watchlist runs key by market-data date so the
 * scheduled job and an Analyze Now on the same day share one object; live runs
 * key by wall-clock instead, because the user can deliberately re-analyse an
 * intraday chart several times within one date and each of those analyses
 * must keep pointing at the chart it was actually read from.
 */
function imageKeyFor(
  source: GeneratedAnalysisSource,
  profileId: string,
  instrumentId: string,
  marketDataDate: string,
  lookbackDays: number,
  extension: string,
): string {
  if (source === "live") {
    return `${profileId}/live/${instrumentId}/${Date.now()}-${lookbackDays}d.${extension}`;
  }
  // The lookback is part of the key: two runs on the same instrument and the
  // same market-data date but different windows render genuinely different
  // charts, and a shared key would leave the earlier analysis pointing at the
  // later run's image.
  return `${profileId}/watchlist-daily/${instrumentId}/${marketDataDate}-${lookbackDays}d.${extension}`;
}

/**
 * Runs the full pipeline. Returns null — having already logged why — if
 * anything fails before a valid analysis is durably stored; the caller is
 * responsible for giving back whatever entitlement it spent.
 */
export async function runInstrumentAnalysis(
  profileId: string,
  ref: InstrumentRef,
  lookbackDays: number,
  source: GeneratedAnalysisSource,
  providedChart?: ProvidedChart | null,
): Promise<InstrumentAnalysisResult | null> {
  let window;
  try {
    window = await getCandlesForInstrument(ref, lookbackDays);
  } catch (cause) {
    logger.error("instrument market-data fetch failed", {
      profileId,
      instrumentKey: ref.instrumentKey,
      reason: cause instanceof MarketDataError ? cause.reason : "unknown",
      cause: String(cause),
    });
    return null;
  }

  if (window.candles.length === 0) {
    logger.error("instrument returned zero candles", {
      profileId,
      instrumentKey: ref.instrumentKey,
    });
    return null;
  }

  const chartCandles = window.candles.slice(-MAX_CANDLES_FOR_CHART);
  const lastCandle = chartCandles[chartCandles.length - 1];

  // The candles are still fetched when the browser supplies the image: they
  // are what dates the analysis and reports its latest price, and they are
  // read from the same cached window the browser's own /api/market/candles
  // call filled, so this costs the upstream provider nothing extra.
  let chart: ProvidedChart;
  if (providedChart) {
    chart = providedChart;
  } else {
    try {
      chart = {
        buffer: await renderCandlestickChart(chartCandles, {
          symbol: ref.symbol,
          name: ref.name,
          exchange: ref.exchange,
          timeframeLabel: window.timeframeLabel,
        }),
        mimetype: "image/png",
      };
    } catch (cause) {
      logger.error("chart image generation failed", {
        profileId,
        instrumentKey: ref.instrumentKey,
        cause: String(cause),
      });
      return null;
    }
  }

  let visual;
  try {
    visual = await runVisualAnalysis(chart.buffer, chart.mimetype);
  } catch (cause) {
    logger.error("instrument AI analysis failed", {
      profileId,
      instrumentKey: ref.instrumentKey,
      errorCode: cause instanceof AnalysisFailure ? cause.code : "unknown",
      cause: String(cause),
    });
    return null;
  }

  const marketDataDate = lastCandle.timestamp.slice(0, 10);
  const imageKey = imageKeyFor(
    source,
    profileId,
    ref.instrumentId,
    marketDataDate,
    lookbackDays,
    extensionForMimeType(chart.mimetype),
  );
  await storeGeneratedChart(imageKey, chart);

  const { data: insertedRow, error: insertError } = await supabaseAdmin
    .from("analyses")
    .insert({
      profile_id: profileId,
      // source_type stays a placeholder required by that column's NOT NULL
      // constraint; `source` below is the real, authoritative provenance
      // signal for a generated (non-uploaded) chart.
      source_type: "upload",
      source,
      instrument_id: ref.instrumentId,
      market_data_date: marketDataDate,
      image_key: imageKey,
      symbol_raw: visual.result.symbol,
      symbol: ref.symbol,
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
      analysis_lookback_days: lookbackDays,
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !insertedRow) {
    logger.error("failed to persist generated analysis", {
      profileId,
      instrumentKey: ref.instrumentKey,
      source,
      cause: String(insertError),
    });
    return null;
  }

  return {
    analysisId: insertedRow.id,
    marketDataDate,
    latestPrice: lastCandle.close,
    analysis: visual.result,
  };
}
