import { z } from "zod";
import { buildChartAnalysisPrompt } from "../prompts/chart-analysis.js";
import { aiClient } from "../lib/ai-client.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

const BUCKET = "chart-images";

/** Bump this manually whenever the prompt in ../prompts/chart-analysis.ts
 *  changes, so every stored analysis stays attributable to the prompt that
 *  produced it. */
const PROMPT_VERSION = "v2";

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type ErrorCode = "api_error" | "invalid_json" | "schema_validation";

/** Thrown internally to carry a machine-readable code out to the single
 *  failure handler at the bottom of processAnalysis(). */
class AnalysisFailure extends Error {
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
    const dataUrl = `data:${mimeTypeForKey(row.image_key)};base64,${buffer.toString("base64")}`;

    // (c) Build the request. response_format json_object — not a stricter
    // schema-enforcing mode — because it is the one JSON mode supported by both
    // the current provider (DeepSeek) and likely future ones (OpenAI), keeping
    // a provider swap free of extra code branches. It only guarantees
    // syntactically valid JSON, never a particular shape, so the result is
    // validated below rather than trusted.
    const prompt = buildChartAnalysisPrompt();
    const request = {
      model: env.aiModel,
      response_format: { type: "json_object" as const },
      // Deliberately generous, and env-driven (AI_MAX_TOKENS) rather than a
      // constant. The currently configured model is a reasoning model: it
      // spends hidden reasoning tokens out of this same completion budget
      // before emitting a single visible character, and how much reasoning a
      // given chart provokes is not fully predictable — testing saw ~3600
      // reasoning tokens on one image and far less on others. Too small a cap
      // means reasoning eats the whole budget, content comes back empty or
      // truncated mid-object, and the analysis fails as invalid_json (retry
      // included, since the retry hits the same cap).
      //
      // 6000 is a practical safety margin over observed behaviour, NOT a
      // proven upper bound. An unusually complex image could still exhaust it;
      // that surfaces as a failed analysis (invalid_json) rather than a
      // silently truncated or fabricated result, which is the safe failure
      // mode — not a bug to chase to zero here.
      //
      // Switching to a non-reasoning model should bring this back down, which
      // is exactly why it is configuration and not a hardcoded constant.
      max_tokens: env.aiMaxTokens,
      messages: [
        { role: "system" as const, content: prompt.system },
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: prompt.user,
            },
            { type: "image_url" as const, image_url: { url: dataUrl } },
          ],
        },
      ],
    };

    // (d) Call the model. DeepSeek's JSON mode can occasionally return empty
    // content, so an empty or unparseable response is retried exactly once —
    // one retry, not a loop.
    let parsed: unknown;
    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let lastFailure: AnalysisFailure | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        logger.error("ai request failed", {
          analysisId,
          attempt,
          cause: String(cause),
        });
        lastFailure = new AnalysisFailure(
          "api_error",
          "The AI provider request failed",
        );
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

    // (e) Validate. A parse success proves nothing about shape; a validation
    // failure is treated exactly like an API failure — no coercion, no partial
    // save.
    const validation = AnalysisSchema.safeParse(parsed);
    if (!validation.success) {
      logger.error("ai response failed schema validation", {
        analysisId,
        issues: validation.error.issues.map((i) => i.path.join(".")).join(", "),
      });
      throw new AnalysisFailure(
        "schema_validation",
        "The AI response did not match the expected analysis shape",
      );
    }
    const result = validation.data;

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
