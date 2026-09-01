import { z } from "zod";
import { buildChartAnalysisPrompt } from "../prompts/chart-analysis.js";
import {
  buildCandleAnalysisPrompt,
  type CandleAnalysisContext,
  type PromptCandle,
} from "../prompts/candle-analysis.js";
import { APIConnectionTimeoutError } from "openai";
import { aiClient } from "../lib/ai-client.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

const BUCKET = "chart-images";

/** Bump this manually whenever the prompt in ../prompts/chart-analysis.ts
 *  changes, so every stored analysis stays attributable to the prompt that
 *  produced it. */
const PROMPT_VERSION = "v2";

/** Version of the candle-series prompt in ../prompts/candle-analysis.ts.
 *  Tracked separately from PROMPT_VERSION: the two prompts are edited
 *  independently, and a stored analysis must stay attributable to whichever
 *  one produced it. */
export const SERIES_PROMPT_VERSION = "series-v1";

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type ErrorCode = "api_error" | "invalid_json" | "schema_validation";

/** Thrown internally to carry a machine-readable code out to the single
 *  failure handler at the bottom of processAnalysis(), and out to
 *  runVisualAnalysis()'s own callers (e.g. the watchlist daily-briefing path). */
export class AnalysisFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const confidence = z.number().min(0).max(1);

// strictObject (not the legacy .strict() method): unexpected fields are
// rejected outright rather than silently dropped, so a model drifting from the
// contract surfaces as a validation failure instead of a half-saved row.
const CallSchema = z.strictObject({
  direction: z.enum(["long", "short", "hold"]),
  confidence,
  entry: z.number().nullable(),
  invalidation: z.number().nullable(),
  target: z.number().nullable(),
  // Integer, matching the int column: a fractional value would pass a loose
  // numeric check here and then fail at the Postgres insert.
  horizon_candles: z.number().int().positive(),
});

const AnalysisSchema = z.strictObject({
  symbol: z.string().nullable(),
  asset_class: z
    .enum(["crypto", "stock", "forex", "commodity", "index"])
    .nullable(),
  timeframe: z.enum(["m1", "m5", "m15", "h1", "h4", "d1", "w1"]).nullable(),
  trend: z.enum(["bullish", "bearish", "neutral"]),
  volatility: z.enum(["low", "medium", "high"]),
  volume: z.enum(["low", "medium", "high"]),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  support_levels: z.array(z.number()),
  resistance_levels: z.array(z.number()),
  patterns: z.array(
    z.strictObject({
      name: z.string(),
      confidence,
      note: z.string(),
    }),
  ),
  call: CallSchema,
  summary: z.string(),
});

function mimeTypeForKey(imageKey: string): string {
  // The extension was set deterministically at upload time, so trusting it here
  // is reliable — no need to sniff file bytes.
  const ext = imageKey.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "image/png";
}

export type AnalysisAiResult = z.infer<typeof AnalysisSchema>;

export interface VisualAnalysisOutcome {
  result: AnalysisAiResult;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * Runs one chart image through the AI provider using the exact same prompt,
 * client, JSON-mode request shape, retry policy and response schema as the
 * manual upload flow — and only that. This is the literal reuse point the
 * product requires between the manual and automated (watchlist daily) flows:
 * the only difference between them is where imageBuffer/mimeType come from
 * (a user's uploaded screenshot vs. a backend-rendered chart image); nothing
 * about the model call itself differs.
 *
 * Throws AnalysisFailure on any failure (provider error, empty/invalid JSON
 * after one retry, or schema validation failure) — never returns a partial or
 * coerced result. Callers decide what "failure" means for their own flow
 * (processAnalysis marks the analyses row failed; the watchlist path also
 * releases the automation-quota unit it consumed).
 */
export async function runVisualAnalysis(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<VisualAnalysisOutcome> {
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
  const prompt = buildChartAnalysisPrompt();

  return runAnalysisCompletion([
    { role: "system", content: prompt.system },
    {
      role: "user",
      content: [
        { type: "text", text: prompt.user },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ]);
}

/**
 * Runs one candle series through the AI provider — the same schema, retry
 * policy and validation as runVisualAnalysis, from the exact OHLCV rows the
 * market-data provider returned instead of a picture of them.
 *
 * This is what the live chart view analyses: the numbers are already exact
 * server-side, so making the model read them back off a rendered image only
 * loses precision. The image is still rendered and stored, but purely so the
 * user can see and download the chart behind their analysis.
 */
export async function runSeriesAnalysis(
  candles: PromptCandle[],
  context: CandleAnalysisContext,
): Promise<VisualAnalysisOutcome> {
  const prompt = buildCandleAnalysisPrompt(candles, context);

  return runAnalysisCompletion([
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ]);
}

/** The message shapes the two entry points above build. */
type AnalysisMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "user";
      content: (
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      )[];
    };

/**
 * Pause before a retry. Without this the second attempt left immediately,
 * which is the worst possible response to the two failures most likely to
 * have caused the first one — a rate limit or an overloaded provider.
 */
const RETRY_BACKOFF_MS = 1_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The shared model call: JSON mode, one retry on an empty or unparseable
 * response (a provider's JSON mode occasionally returns empty content — one
 * retry, not a loop), then schema validation.
 *
 * This is the ONLY retry policy in the AI path: the SDK client is constructed
 * with maxRetries: 0 (see lib/ai-client.ts) precisely so its silent internal
 * retries cannot multiply with this loop.
 *
 * max_tokens is deliberately generous and env-driven (AI_MAX_TOKENS) rather
 * than a constant.
 */
async function runAnalysisCompletion(
  messages: AnalysisMessage[],
): Promise<VisualAnalysisOutcome> {
  const request = {
    model: env.aiModel,
    response_format: { type: "json_object" as const },
    max_tokens: env.aiMaxTokens,
    messages,
  };

  let parsed: unknown;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let lastFailure: AnalysisFailure | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Only ever between attempts, never before the first one or after the last.
    if (attempt > 0) {
      await delay(RETRY_BACKOFF_MS);
    }

    const startedAt = Date.now();
    let content: string | null | undefined;
    try {
      const completion = await aiClient.chat.completions.create(request);
      latencyMs = Date.now() - startedAt;
      content = completion.choices[0]?.message?.content;
      inputTokens = completion.usage?.prompt_tokens ?? 0;
      outputTokens = completion.usage?.completion_tokens ?? 0;
    } catch (cause) {
      latencyMs = Date.now() - startedAt;
      logger.error("ai request failed", { attempt, latencyMs, cause: String(cause) });
      lastFailure = new AnalysisFailure("api_error", "The AI provider request failed");

      // A timeout is the one failure that must NOT be retried. The other two
      // (an empty response, unparseable JSON) come back in seconds and leave
      // most of the caller's patience intact, so a second attempt is free to
      // succeed. A timeout has already spent the entire request budget by
      // definition — retrying it guarantees the browser has stopped waiting
      // before the second attempt can even finish, and turns one slow analysis
      // into two, on a provider that is evidently already struggling.
      if (cause instanceof APIConnectionTimeoutError) {
        lastFailure = new AnalysisFailure(
          "api_error",
          "The AI provider did not respond in time",
        );
        break;
      }

      continue;
    }

    if (!content) {
      lastFailure = new AnalysisFailure(
        "invalid_json",
        "The AI provider returned an empty response",
      );
      continue;
    }

    try {
      parsed = JSON.parse(content);
      lastFailure = undefined;
      break;
    } catch {
      lastFailure = new AnalysisFailure(
        "invalid_json",
        "The AI provider returned a response that was not valid JSON",
      );
    }
  }

  if (lastFailure) {
    throw lastFailure;
  }

  const validation = AnalysisSchema.safeParse(parsed);
  if (!validation.success) {
    logger.error("ai response failed schema validation", {
      issues: validation.error.issues.map((i) => i.path.join(".")).join(", "),
    });
    throw new AnalysisFailure(
      "schema_validation",
      "The AI response did not match the expected analysis shape",
    );
  }

  return { result: validation.data, inputTokens, outputTokens, latencyMs };
}

/**
 * Runs the AI analysis for a queued analyses row and writes the result back.
 *
 * Invoked fire-and-forget from the route, so it must NEVER throw or let a
 * rejection escape: an unhandled rejection in a background task takes the
 * process down. Every code path — including the one where the failure handler's
 * own DB write fails — resolves normally.
 *
 * Quota is deliberately untouched here, on both the success and failure paths.
 * The quota unit was consumed when the analysis was created, before this
 * function ever ran, and it stays consumed even when the AI call fails. This is
 * NOT the same situation as the upload-failure compensation in
 * analysis.service.ts: there the image was never durably stored and nothing
 * happened; here the image IS stored and the attempt genuinely happened.
 * Refunding on AI failure would need its own deliberate policy (e.g. refund on
 * provider outages but not on validation failures) and is out of scope — a
 * product decision to revisit, not a bug.
 */
export async function processAnalysis(analysisId: string): Promise<void> {
  try {
    // (a) Load the row.
    const { data: row, error: fetchError } = await supabaseAdmin
      .from("analyses")
      .select("id, image_key")
      .eq("id", analysisId)
      .single();

    if (fetchError || !row) {
      throw new AnalysisFailure(
        "api_error",
        "Analysis row could not be loaded",
      );
    }

    // (b) Download the stored image and inline it as a base64 data URL.
    const { data: blob, error: downloadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(row.image_key);

    if (downloadError || !blob) {
      throw new AnalysisFailure(
        "api_error",
        "Chart image could not be downloaded from storage",
      );
    }

    const buffer = Buffer.from(await blob.arrayBuffer());

    // (c)-(e) Model call, retry-once, and schema validation — factored out
    // into runVisualAnalysis() so this exact logic is shared verbatim with
    // the watchlist daily-briefing path (see daily-briefing.service.ts).
    const { result, inputTokens, outputTokens, latencyMs } = await runVisualAnalysis(
      buffer,
      mimeTypeForKey(row.image_key),
    );

    // (f) Persist. cost_usd is an ESTIMATE derived from the configured
    // per-million-token rates: it is not guaranteed to match the provider's
    // invoice (DeepSeek's actual billing varies with cache hit/miss and
    // peak/off-peak timing). It exists for internal logging and margin
    // tracking, not for reconciliation with the provider's bill.
    const costUsd =
      (inputTokens / 1_000_000) * env.aiInputCostPerM +
      (outputTokens / 1_000_000) * env.aiOutputCostPerM;

    const { error: updateError } = await supabaseAdmin
      .from("analyses")
      .update({
        // symbol_raw, not symbol: this is exactly what the model read off the
        // chart, unnormalized. symbol holds the normalized/matched symbol and
        // stays null until phase-2 symbol matching exists to populate it.
        symbol_raw: result.symbol,
        asset_class: result.asset_class,
        timeframe: result.timeframe,
        trend: result.trend,
        volatility: result.volatility,
        volume_reading: result.volume,
        sentiment: result.sentiment,
        support_levels: result.support_levels,
        resistance_levels: result.resistance_levels,
        call_direction: result.call.direction,
        call_confidence: result.call.confidence,
        call_entry: result.call.entry,
        call_invalidation: result.call.invalidation,
        call_target: result.call.target,
        horizon_candles: result.call.horizon_candles,
        summary: result.summary,
        model_id: env.aiModel,
        prompt_version: PROMPT_VERSION,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        status: "complete",
        error_code: null,
        error_message: null,
      })
      .eq("id", analysisId);

    if (updateError) {
      throw new AnalysisFailure(
        "api_error",
        "The analysis result could not be saved",
      );
    }

    if (result.patterns.length > 0) {
      const { error: patternsError } = await supabaseAdmin
        .from("analysis_patterns")
        .insert(
          result.patterns.map((pattern) => ({
            analysis_id: analysisId,
            pattern_key: pattern.name,
            confidence: pattern.confidence,
            pattern_note: pattern.note,
          })),
        );
      // The analysis itself is already complete and useful without its pattern
      // rows, so a pattern insert failure is logged rather than flipping the
      // row back to 'failed'. The row does, however, get marked with an
      // error_code so that "complete but missing its pattern rows" is an
      // explicitly queryable state rather than indistinguishable from a fully
      // successful analysis — anything reading analysis_patterns for a
      // 'complete' analysis (e.g. per-pattern hit-rate tracking) needs to be
      // able to find these rows.
      if (patternsError) {
        logger.error("failed to insert analysis patterns", {
          analysisId,
          cause: String(patternsError),
        });

        // Marking is best-effort: it must not throw out to the outer catch,
        // which would flip this already-'complete' row to 'failed' and discard
        // a valid AI result. No retry of the insert itself.
        try {
          const { error: markError } = await supabaseAdmin
            .from("analyses")
            .update({
              error_code: "patterns_insert_failed",
              error_message: String(patternsError),
            })
            .eq("id", analysisId);
          if (markError) {
            throw markError;
          }
        } catch (secondary) {
          logger.error("failed to mark analysis patterns failure", {
            analysisId,
            cause: String(secondary),
          });
        }
      }
    }

    logger.info("analysis complete", { analysisId, latencyMs });
  } catch (cause) {
    const failure =
      cause instanceof AnalysisFailure
        ? cause
        : new AnalysisFailure("api_error", "The analysis could not be processed");

    logger.error("analysis failed", {
      analysisId,
      errorCode: failure.code,
      cause: String(cause),
    });

    // The whole point of the outer try/catch is preventing an unhandled
    // background rejection, so the failure handler must not be able to reject
    // either. If marking the row 'failed' itself fails, log and swallow.
    try {
      const { error: failUpdateError } = await supabaseAdmin
        .from("analyses")
        .update({
          status: "failed",
          error_code: failure.code,
          // Human-readable only — never a raw stack trace or anything carrying
          // credentials or provider internals.
          error_message: failure.message,
        })
        .eq("id", analysisId);
      if (failUpdateError) {
        throw failUpdateError;
      }
    } catch (secondary) {
      logger.error("failed to mark analysis as failed", {
        analysisId,
        cause: String(secondary),
      });
    }
  }
}

/**
 * Age past which a still-'queued' row cannot plausibly be a run in flight.
 * The bound on one real run is two model attempts (60s each, see
 * lib/ai-client.ts) plus a backoff and the storage round trips, so this sits
 * several times past the worst legitimate case.
 */
const STRANDED_AFTER_MS = 10 * 60_000;

/**
 * Upper bound on rows re-dispatched per sweep. A restart during an incident
 * can leave a lot of these, and running them all at once would aim a burst of
 * model calls at a provider that may be the reason they are stranded.
 */
const MAX_RECLAIM_BATCH = 20;

/**
 * Re-dispatches analyses left at 'queued' by a process restart.
 *
 * The route dispatches processAnalysis fire-and-forget, so a restart between
 * the 201 and the model returning used to strand that row at 'queued'
 * permanently: the user's entitlement was spent, the UI polled until it timed
 * out, and nothing would ever pick the row up again.
 *
 * Re-running is the right recovery rather than marking the row failed. The
 * image is already durably stored and the entitlement is already spent, so
 * processing it is what the user actually paid for — and it needs no refund
 * policy, which matters because the row does not record whether a quota unit
 * or a credit was consumed. A re-run that fails for a real reason still ends
 * up 'failed' through processAnalysis's own handler, exactly as a first
 * attempt would.
 *
 * Sequential and bounded, and never throws — it is called from a timer.
 */
export async function reclaimStrandedAnalyses(): Promise<number> {
  const cutoff = new Date(Date.now() - STRANDED_AFTER_MS).toISOString();

  // Served by analyses_status_created_at_idx.
  const { data, error } = await supabaseAdmin
    .from("analyses")
    .select("id")
    .eq("status", "queued")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_RECLAIM_BATCH)
    .returns<{ id: string }[]>();

  if (error) {
    logger.error("stranded analysis sweep query failed", { cause: String(error) });
    return 0;
  }

  const rows = data ?? [];
  if (rows.length === 0) return 0;

  logger.info("reclaiming stranded analyses", { count: rows.length });

  for (const row of rows) {
    // processAnalysis never rejects, by contract, so one bad row cannot stop
    // the sweep from reaching the rest.
    await processAnalysis(row.id);
  }

  return rows.length;
}
