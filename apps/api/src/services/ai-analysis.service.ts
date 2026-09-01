import { z } from "zod";
import { buildChartAnalysisPrompt } from "../prompts/chart-analysis.js";
import {
  buildCandleAnalysisPrompt,
  type CandleAnalysisContext,
  type PromptCandle,
} from "../prompts/candle-analysis.js";
import { APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "openai";
import { aiProviders, type AiProvider } from "../lib/ai-client.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

const BUCKET = "chart-images";

/** Bump this manually whenever the prompt in ../prompts/chart-analysis.ts
 *  changes, so every stored analysis stays attributable to the prompt that
 *  produced it.
 *
 *  Exported because the generated-chart pipeline stores it too: that path used
 *  to carry its own hardcoded "v2" copy, which would have gone silently stale
 *  the first time this was bumped. */
export const VISUAL_PROMPT_VERSION = "v2";

/** Version of the candle-series prompt in ../prompts/candle-analysis.ts.
 *  Tracked separately from VISUAL_PROMPT_VERSION: the two prompts are edited
 *  independently, and a stored analysis must stay attributable to whichever
 *  one produced it. */
export const SERIES_PROMPT_VERSION = "series-v1";

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type ErrorCode =
  | "api_error"
  | "invalid_json"
  | "schema_validation"
  /** The provider refused on quota/rate grounds — retrying now cannot help. */
  | "rate_limited"
  /** The configured API key was rejected. An operator problem, not a user one. */
  | "provider_auth";

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
  // Both prompts (prompts/chart-analysis.ts, prompts/candle-analysis.ts) tell
  // the model to answer "none" when the chart supports no trade — a deliberate,
  // and deliberately common, abstention. The stored enum (public.call_direction)
  // spells that same state "hold". Accepting both spellings and normalising to
  // the stored one here is what stops a correct abstention from failing schema
  // validation, which would fail the whole analysis and spend the user's
  // entitlement on a run that actually worked.
  direction: z
    .enum(["long", "short", "hold", "none"])
    .transform((value) => (value === "none" ? "hold" : value)),
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
  /** The model that actually served the call — not necessarily the primary's,
   *  since the chain may have failed over. Stored on the analyses row so a
   *  result stays attributable to the model behind it. */
  modelId: string;
  /** Estimated spend at THAT provider's configured rates. */
  costUsd: number;
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
  ], true);
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
  ], false);
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
 * Estimated provider spend for one completed call, at the rates configured for
 * the provider that actually served it.
 *
 * An ESTIMATE derived from the configured per-million-token rates: it is not
 * guaranteed to match the provider's invoice (actual billing varies with cache
 * hit/miss and peak/off-peak timing). It exists for internal logging and margin
 * tracking, not for reconciliation with the provider's bill.
 */
function estimateCostUsd(
  provider: AiProvider,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * provider.inputCostPerM +
    (outputTokens / 1_000_000) * provider.outputCostPerM
  );
}

/**
 * One provider's turn: JSON mode, one retry on an empty or unparseable
 * response (a provider's JSON mode occasionally returns empty content — one
 * retry, not a loop), then schema validation.
 *
 * This is the ONLY retry policy in the AI path: the SDK client is constructed
 * with maxRetries: 0 (see lib/ai-client.ts) precisely so its silent internal
 * retries cannot multiply with this loop.
 *
 * Returns the outcome, or the AnalysisFailure that ended this provider's turn.
 * It returns rather than throws because the caller's job is to decide whether
 * to move down the chain, and a thrown value there would be indistinguishable
 * from a bug in the loop itself.
 *
 * max_tokens is deliberately generous and per-provider config rather than a
 * constant.
 */
async function runOnProvider(
  provider: AiProvider,
  messages: AnalysisMessage[],
): Promise<VisualAnalysisOutcome | AnalysisFailure> {
  const request = {
    model: provider.model,
    response_format: { type: "json_object" as const },
    max_tokens: provider.maxTokens,
    messages,
  };

  let lastFailure: AnalysisFailure = new AnalysisFailure(
    "api_error",
    "The AI provider request failed",
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Only ever between attempts, never before the first one or after the last.
    if (attempt > 0) {
      await delay(RETRY_BACKOFF_MS);
    }

    const startedAt = Date.now();
    let content: string | null | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    try {
      const completion = await provider.client.chat.completions.create(request);
      latencyMs = Date.now() - startedAt;
      content = completion.choices[0]?.message?.content;
      inputTokens = completion.usage?.prompt_tokens ?? 0;
      outputTokens = completion.usage?.completion_tokens ?? 0;
    } catch (cause) {
      latencyMs = Date.now() - startedAt;
      logger.error("ai request failed", {
        provider: provider.name,
        attempt,
        latencyMs,
        cause: String(cause),
      });
      lastFailure = new AnalysisFailure("api_error", "The AI provider request failed");

      // A timeout is one of the failures that must NOT be retried on the SAME
      // provider. An empty response and unparseable JSON come back in seconds
      // and leave most of the caller's patience intact, so a second attempt is
      // free to succeed. A timeout has already spent the entire request budget
      // by definition — retrying it here turns one slow analysis into two, on a
      // provider that is evidently already struggling. Handing it to the next
      // provider instead is the whole reason the chain exists.
      if (cause instanceof APIConnectionTimeoutError) {
        return new AnalysisFailure("api_error", "The AI provider did not respond in time");
      }

      // Neither is a rate limit. The provider is telling us it will not serve
      // this request yet — and says how long to wait, typically far longer
      // than the backoff here. Retrying immediately just spends a second
      // request against the very quota that is already exhausted, and on a
      // per-day cap the second attempt cannot possibly succeed. The next
      // provider has its own quota, which is exactly what should be used.
      if (cause instanceof RateLimitError) {
        return new AnalysisFailure(
          "rate_limited",
          "The AI provider is rate limiting requests right now",
        );
      }

      // A rejected key is a configuration problem. No number of retries against
      // this provider fixes it, and each one is another request logged against
      // a bad credential.
      if (cause instanceof AuthenticationError) {
        return new AnalysisFailure(
          "provider_auth",
          "The AI provider rejected our credentials",
        );
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      lastFailure = new AnalysisFailure(
        "invalid_json",
        "The AI provider returned a response that was not valid JSON",
      );
      continue;
    }

    const validation = AnalysisSchema.safeParse(parsed);
    if (!validation.success) {
      logger.error("ai response failed schema validation", {
        provider: provider.name,
        issues: validation.error.issues.map((i) => i.path.join(".")).join(", "),
      });
      lastFailure = new AnalysisFailure(
        "schema_validation",
        "The AI response did not match the expected analysis shape",
      );
      continue;
    }

    return {
      result: validation.data,
      inputTokens,
      outputTokens,
      latencyMs,
      modelId: provider.model,
      costUsd: estimateCostUsd(provider, inputTokens, outputTokens),
    };
  }

  return lastFailure;
}

/**
 * The shared model call, across the configured provider chain.
 *
 * Providers are tried in configured order and the first usable result wins, so
 * an outage, a rate limit or a rejected key on the primary costs the user a few
 * extra seconds instead of a failed analysis. Only when every eligible provider
 * has had its turn does the failure reach the caller, carrying the LAST
 * provider's error code — the primary's code would describe a provider that is
 * no longer the reason the request failed.
 *
 * needsVision drops text-only providers from the chain: sending an image_url
 * part to a text-only model is a guaranteed failure, and spending an attempt
 * (and the user's wait) on it is worse than not having the fallback at all. A
 * chain with no vision-capable provider fails immediately rather than
 * pretending to try.
 */
async function runAnalysisCompletion(
  messages: AnalysisMessage[],
  needsVision: boolean,
): Promise<VisualAnalysisOutcome> {
  const chain = needsVision
    ? aiProviders.filter((provider) => provider.supportsVision)
    : aiProviders;

  if (chain.length === 0) {
    throw new AnalysisFailure(
      "api_error",
      "No configured AI provider can read chart images",
    );
  }

  let lastFailure = new AnalysisFailure("api_error", "The AI provider request failed");

  for (const [index, provider] of chain.entries()) {
    const outcome = await runOnProvider(provider, messages);

    if (!(outcome instanceof AnalysisFailure)) {
      // Worth a log line at info: which provider served a call is the only way
      // to notice the primary is quietly always failing over.
      if (index > 0) {
        logger.info("ai provider fallback used", {
          provider: provider.name,
          model: provider.model,
        });
      }
      return outcome;
    }

    lastFailure = outcome;
    logger.error("ai provider exhausted, falling back", {
      provider: provider.name,
      code: outcome.code,
      remaining: chain.length - index - 1,
    });
  }

  throw lastFailure;
}

/**
 * Writes an analysis's detected patterns, best-effort.
 *
 * The analysis itself is already complete and useful without its pattern rows,
 * so a failure here is recorded rather than thrown: throwing would flip an
 * already-'complete' row to 'failed' and discard a valid AI result. The row does
 * get an error_code, so "complete but missing its pattern rows" stays an
 * explicitly queryable state rather than being indistinguishable from a fully
 * successful analysis — anything reading analysis_patterns for a 'complete'
 * analysis (e.g. per-pattern hit-rate tracking) needs to be able to find these.
 *
 * Shared by every path that stores an analysis: the manual upload pipeline and
 * the generated-chart pipeline behind the live view and the daily briefing.
 * Without it the generated paths silently dropped every pattern the model
 * found, and their results always read "No patterns detected".
 *
 * Never throws.
 */
export async function insertAnalysisPatterns(
  analysisId: string,
  patterns: AnalysisAiResult["patterns"],
): Promise<void> {
  if (patterns.length === 0) return;

  const { error: patternsError } = await supabaseAdmin.from("analysis_patterns").insert(
    patterns.map((pattern) => ({
      analysis_id: analysisId,
      pattern_key: pattern.name,
      confidence: pattern.confidence,
      pattern_note: pattern.note,
    })),
  );
  if (!patternsError) return;

  logger.error("failed to insert analysis patterns", {
    analysisId,
    cause: String(patternsError),
  });

  // Marking is best-effort and must not throw out to a caller that would treat
  // it as the analysis failing. No retry of the insert itself.
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
      .single<{ id: string; image_key: string }>();

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
    const { result, inputTokens, outputTokens, latencyMs, modelId, costUsd } =
      await runVisualAnalysis(buffer, mimeTypeForKey(row.image_key));

    // (f) Persist. See estimateCostUsd for what cost_usd is and is not.

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
        model_id: modelId,
        prompt_version: VISUAL_PROMPT_VERSION,
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

    await insertAnalysisPatterns(analysisId, result.patterns);

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
    .select("id, source")
    .eq("status", "queued")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_RECLAIM_BATCH)
    .returns<{ id: string; source: string }[]>();

  if (error) {
    logger.error("stranded analysis sweep query failed", { cause: String(error) });
    return 0;
  }

  const rows = data ?? [];
  if (rows.length === 0) return 0;

  // Only an uploaded screenshot can be re-run from its row alone: the image is
  // in storage and processAnalysis needs nothing else. A generated analysis
  // (the live view, the daily briefing) is stranded mid-pipeline with no image
  // stored yet and its market-data window long since gone stale, so re-running
  // it through the visual pipeline would only fail in a confusing way. Those
  // are marked failed instead, which is what actually unblocks the client
  // watching the row.
  const rerunnable = rows.filter((row) => row.source === "manual");
  const abandoned = rows.filter((row) => row.source !== "manual");

  logger.info("reclaiming stranded analyses", {
    rerunning: rerunnable.length,
    failing: abandoned.length,
  });

  for (const row of abandoned) {
    const { error: markError } = await supabaseAdmin
      .from("analyses")
      .update({
        status: "failed",
        error_code: "api_error",
        error_message: "The analysis was interrupted and could not be completed",
      })
      .eq("id", row.id)
      // Only if it is still queued: the pipeline may have finished it between
      // the query above and this write.
      .eq("status", "queued");
    if (markError) {
      logger.error("failed to mark stranded analysis as failed", {
        analysisId: row.id,
        cause: String(markError),
      });
    }
  }

  for (const row of rerunnable) {
    // processAnalysis never rejects, by contract, so one bad row cannot stop
    // the sweep from reaching the rest.
    await processAnalysis(row.id);
  }

  return rows.length;
}
