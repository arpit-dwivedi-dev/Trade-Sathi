import type { ZodType } from "zod";
import {
  callDirectionFor,
  primaryScenario,
  type AnalysisResult,
} from "@chartanalyzer/shared";
import {
  SeriesAnalysisSchema,
  VisionAnalysisSchema,
  normalizeSeriesAnalysis,
  normalizeVisionAnalysis,
} from "./analysis-schema.js";
import { buildChartAnalysisPrompt } from "../prompts/chart-analysis.js";
import {
  buildCandleAnalysisPrompt,
  type CandleAnalysisContext,
  type PromptCandle,
} from "../prompts/candle-analysis.js";
import {
  buildFundamentalsAnalysisPrompt,
  type FundamentalsPromptInput,
} from "../prompts/fundamentals-analysis.js";
import {
  findSemanticViolations,
  FundamentalsAiSchema,
  normalizeFundamentalsAnalysis,
  repairDisallowedUnkClaimTags,
  repairHoistedVerdictKeys,
} from "./fundamentals-analysis-schema.js";
import type { DerivedFundamentals, FundamentalsAnalysisResult } from "@chartanalyzer/shared";
import { APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "openai";
import { aiProviders, type AiProvider } from "../lib/ai-client.js";
import { logAppError } from "../lib/error-log.js";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";

const BUCKET = "chart-images";

/** Bump this manually whenever the prompt in ../prompts/chart-analysis.ts
 *  changes, so every stored analysis stays attributable to the prompt that
 *  produced it.
 *
 *  Exported because the generated-chart pipeline stores it too: that path used
 *  to carry its own hardcoded "v2" copy, which would have gone silently stale
 *  the first time this was bumped. */
export const VISUAL_PROMPT_VERSION = "v3";

/** Version of the candle-series prompt in ../prompts/candle-analysis.ts.
 *  Tracked separately from VISUAL_PROMPT_VERSION: the two prompts are edited
 *  independently, and a stored analysis must stay attributable to whichever
 *  one produced it. */
export const SERIES_PROMPT_VERSION = "series-v2";

/** Version of the fundamentals prompt in ../prompts/fundamentals-analysis.ts.
 *  Tracked separately for the same reason as SERIES_PROMPT_VERSION. */
export const FUNDAMENTALS_PROMPT_VERSION = "fundamentals-v3";

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

/**
 * How one provider response is turned into a stored result: parse the model's
 * json against the schema that mirrors the prompt it was given, then normalise
 * it into the single shape the rest of the system reads.
 *
 * It is a parameter rather than a constant because the two prompts genuinely
 * differ — a screenshot read reports its own pixel-read error and a list of
 * blockers, a candle read reports an exact close and a corporate-action check
 * — and validating either response against the other's schema would reject a
 * perfectly good answer. See services/analysis-schema.ts.
 */
type ResponseValidator<T> = (payload: unknown) =>
  | { ok: true; result: T }
  | { ok: false; issues: string };

function validatorFor<T, R>(
  schema: ZodType<T, unknown>,
  normalize: (parsed: T) => R,
): ResponseValidator<R> {
  return (payload) => {
    const validation = schema.safeParse(payload);
    if (!validation.success) {
      return {
        ok: false,
        // Paths only — the issue messages can quote model output, and this
        // string reaches the logs.
        issues: validation.error.issues.map((issue) => issue.path.join(".")).join(", "),
      };
    }
    return { ok: true, result: normalize(validation.data) };
  };
}

const validateVisionResponse = validatorFor(VisionAnalysisSchema, normalizeVisionAnalysis);
const validateSeriesResponse = validatorFor(SeriesAnalysisSchema, normalizeSeriesAnalysis);

/**
 * Fundamentals gets its own validator, not the generic validatorFor above,
 * because it runs two repair steps first — see repairHoistedVerdictKeys and
 * repairDisallowedUnkClaimTags in fundamentals-analysis-schema.ts. Structural
 * repair (putting a wrongly-placed key back inside its section) runs before
 * content repair (fixing a disallowed tag value) so the second step sees
 * sections in their intended shape.
 */
function validateFundamentalsResponse(
  payload: unknown,
  derived: DerivedFundamentals,
): { ok: true; result: FundamentalsAnalysisResult } | { ok: false; issues: string } {
  const repaired = repairDisallowedUnkClaimTags(repairHoistedVerdictKeys(payload));
  const validation = FundamentalsAiSchema.safeParse(repaired);
  if (!validation.success) {
    return {
      ok: false,
      issues: validation.error.issues.map((issue) => issue.path.join(".")).join(", "),
    };
  }

  const result = normalizeFundamentalsAnalysis(validation.data);

  // Semantic checks that need the derived payload: the verdicts the model was
  // told to copy, stance coherence, and scenario validity at publication. A
  // violation is reported as a validation failure so the retry loop
  // regenerates — the pipeline no longer silently patches a bad response.
  const violations = findSemanticViolations(result, derived);
  if (violations.length > 0) {
    logger.warn("fundamentals response rejected on semantic validation", {
      violations,
    });
    return { ok: false, issues: violations.join("; ") };
  }

  return { ok: true, result };
}

/**
 * The columns a completed analysis writes outside of `analysis_result`.
 *
 * Everything here is also inside the payload; it is lifted out only because
 * the History list renders these per row and reading them out of jsonb for
 * every row of every page is what the promotion buys. Anything the detail view
 * alone needs stays in the payload, where it cannot drift from it.
 *
 * The legacy reading columns (trend, volatility, volume_reading, sentiment,
 * asset_class, call_confidence, call_entry, call_target, call_invalidation,
 * support_levels, resistance_levels) are deliberately absent: the current
 * prompts produce none of them — they explicitly forbid a sentiment field and
 * pattern names, and a level is now a band rather than a price — so leaving
 * them null is the honest record. Rows written before this change keep their
 * values; see supabase/migrations/20260904130000_analysis_result_payload.sql.
 */
export function analysisResultColumns(result: AnalysisResult) {
  const primary = primaryScenario(result);
  return {
    analysis_result: result,
    // symbol_raw, not symbol: exactly what the model read, unnormalized.
    symbol_raw: result.identity.symbol_text,
    timeframe: result.identity.timeframe,
    instrument_type: result.identity.instrument_type,
    structure_state: result.structure.state,
    setup_format: result.setup.format,
    call_direction: callDirectionFor(result),
    // Null for an abstention and for a two-scenario read, which have no single
    // horizon — the per-scenario values live in the payload either way.
    horizon_candles: result.setup.format === "two_scenario" ? null : (primary?.horizon_candles ?? null),
    summary: result.summary,
  };
}

function mimeTypeForKey(imageKey: string): string {
  // The extension was set deterministically at upload time, so trusting it here
  // is reliable — no need to sniff file bytes.
  const ext = imageKey.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "image/png";
}

/** Generic over the result type so the fundamentals prompt (which validates
 *  into `FundamentalsAnalysisResult`, not `AnalysisResult`) shares this shape
 *  and everything below it rather than duplicating it — see ResponseValidator. */
export interface VisualAnalysisOutcome<T = AnalysisResult> {
  result: T;
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
 * refunds the daily_briefing_run credit it consumed).
 */
export async function runVisualAnalysis(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<VisualAnalysisOutcome> {
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
  const prompt = buildChartAnalysisPrompt();

  return runAnalysisCompletion(
    [
      { role: "system", content: prompt.system },
      {
        role: "user",
        content: [
          { type: "text", text: prompt.user },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    true,
    validateVisionResponse,
  );
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

  return runAnalysisCompletion(
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    false,
    validateSeriesResponse,
  );
}

/**
 * Runs one derived-fundamentals payload through the AI provider — the same
 * client, JSON-mode request shape, retry policy and provider-fallback chain
 * as runVisualAnalysis/runSeriesAnalysis, against the fundamentals prompt
 * (see prompts/fundamentals-analysis.ts) instead of a chart read. Text/JSON
 * only, so needsVision is false: no image is ever sent.
 *
 * NO POST-HOC RECONCILIATION. Four reconcilers used to sit here, rewriting
 * the model's leverage band, growth verdict, dividend sustainability and
 * executive stance after the fact. They existed only because the model was
 * allowed to derive those verdicts in the first place; the derivation layer
 * now computes them and the prompt hands them over to be copied, so there is
 * nothing left to correct. The one rule worth keeping — that an "attractive"
 * stance must not contradict the very sections it follows from — moved into
 * schema validation, where a violation is a rejected response rather than a
 * silently patched one.
 */
export async function runFundamentalsAnalysis(
  input: FundamentalsPromptInput,
): Promise<VisualAnalysisOutcome<FundamentalsAnalysisResult>> {
  const prompt = buildFundamentalsAnalysisPrompt(input);

  return runAnalysisCompletion(
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    false,
    (raw) => validateFundamentalsResponse(raw, input.derived),
  );
}

/** The message shapes the three entry points above build. */
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
 * Escapes a literal newline, carriage return or tab found INSIDE a json
 * string literal, leaving everything outside of string literals (including
 * legitimate structural whitespace between tokens) untouched. json.parse
 * rejects a raw control character inside a string per spec; this repairs
 * exactly that one violation without altering the parsed value.
 *
 * A linear scan tracking only "currently inside a string, and was the
 * previous character an unconsumed backslash" is sufficient here — this
 * does not need to understand json structure beyond string boundaries, only
 * to avoid rewriting a character that is already a valid two-character
 * escape sequence (e.g. an existing "\n").
 */
function escapeControlCharsInsideJsonStrings(text: string): string {
  let result = "";
  let inString = false;
  let escapedNext = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      continue;
    }
    if (escapedNext) {
      result += ch;
      escapedNext = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escapedNext = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }
    if (ch === "\n") {
      result += "\\n";
      continue;
    }
    if (ch === "\r") {
      result += "\\r";
      continue;
    }
    if (ch === "\t") {
      result += "\\t";
      continue;
    }
    result += ch;
  }
  return result;
}

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
async function runOnProvider<T>(
  provider: AiProvider,
  messages: AnalysisMessage[],
  validate: ResponseValidator<T>,
): Promise<VisualAnalysisOutcome<T> | AnalysisFailure> {
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
      // Observed in production (a weaker fallback model on a fundamentals
      // call): a model asked for "one json object and nothing else" instead
      // writes its reasoning directly into a string field — most often
      // meta.confidence_reason, which the prompt invites a justification
      // into — as literal, un-escaped newlines, which JSON.parse rejects
      // outright even though the content is otherwise well-formed. One
      // retry against the repaired text recovers a response that would
      // otherwise burn this provider's whole turn over a punctuation-level
      // slip, not a content problem.
      try {
        parsed = JSON.parse(escapeControlCharsInsideJsonStrings(content));
      } catch {
        lastFailure = new AnalysisFailure(
          "invalid_json",
          "The AI provider returned a response that was not valid JSON",
        );
        continue;
      }
    }

    const validation = validate(parsed);
    if (!validation.ok) {
      logger.error("ai response failed schema validation", {
        provider: provider.name,
        issues: validation.issues,
      });
      lastFailure = new AnalysisFailure(
        "schema_validation",
        "The AI response did not match the expected analysis shape",
      );
      continue;
    }

    return {
      result: validation.result,
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
async function runAnalysisCompletion<T>(
  messages: AnalysisMessage[],
  needsVision: boolean,
  validate: ResponseValidator<T>,
): Promise<VisualAnalysisOutcome<T>> {
  const chain = needsVision
    ? aiProviders.filter((provider) => provider.supportsVision)
    : aiProviders;

  if (chain.length === 0) {
    throw new AnalysisFailure(
      "api_error",
      needsVision
        ? "No configured AI provider can read chart images"
        : "No configured AI provider is available",
    );
  }

  const failures: AnalysisFailure[] = [];

  for (const [index, provider] of chain.entries()) {
    const outcome = await runOnProvider(provider, messages, validate);

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

    failures.push(outcome);
    logger.error("ai provider exhausted, falling back", {
      provider: provider.name,
      code: outcome.code,
      remaining: chain.length - index - 1,
    });
  }

  throw mostDiagnosticFailure(failures);
}

/**
 * When every provider in the chain has failed, which failure to surface.
 *
 * Not simply the last one. Observed in production: a rate-limited Gemini key
 * (its free tier caps each model at 20 requests/day) exhausts two of three
 * Gemini providers in the chain within the same request, the chain falls
 * through to a lone, unaffected provider, and THAT one produces one genuine
 * schema mismatch — so the code reported to the user is "schema_validation"
 * ("the analysis came back in an unexpected format") even though the real,
 * actionable story is that the account is out of quota. The last code in a
 * fallback chain describes whichever provider happened to run out of
 * providers to hand off to, not the failure most worth acting on.
 *
 * `provider_auth` and `rate_limited` are operator-actionable and never
 * transient in the way a retry advises; either one anywhere in the chain is
 * the honest headline. `api_error` is next: still an infrastructure problem,
 * not a content one. `schema_validation`/`invalid_json` are reported only
 * when nothing else explains the run — which is also the one case where "try
 * again" is actually good advice.
 */
function mostDiagnosticFailure(failures: AnalysisFailure[]): AnalysisFailure {
  const priority: ErrorCode[] = ["provider_auth", "rate_limited", "api_error"];
  for (const code of priority) {
    const match = failures.find((f) => f.code === code);
    if (match) return match;
  }
  return failures[failures.length - 1];
}

/*
 * insertAnalysisPatterns() used to live here, writing the model's detected
 * patterns into public.analysis_patterns. Both prompts now prohibit pattern
 * names outright ("No pattern names anywhere in the output. Do not add a
 * patterns array."), so there is nothing left to write and the function is
 * gone rather than kept as a no-op.
 *
 * The table and its rows stay: they hold the patterns from every analysis run
 * before this change, and the History detail view still renders them for those
 * rows. Nothing writes it any more.
 */

/**
 * Runs the AI analysis for a queued analyses row and writes the result back.
 *
 * Invoked fire-and-forget from the route, so it must NEVER throw or let a
 * rejection escape: an unhandled rejection in a background task takes the
 * process down. Every code path — including the one where the failure handler's
 * own DB write fails — resolves normally.
 *
 * The chart_analysis credit is deliberately untouched here, on both the
 * success and failure paths. It was consumed when the analysis was created,
 * before this function ever ran, and it stays consumed even when the AI call
 * fails. This is NOT the same situation as the upload-failure compensation in
 * analysis.service.ts: there the image was never durably stored and nothing
 * happened; here the image IS stored and the attempt genuinely happened.
 * Refunding on AI failure would need its own deliberate policy (e.g. refund on
 * provider outages but not on validation failures) and is out of scope — a
 * product decision to revisit, not a bug.
 */
export async function processAnalysis(analysisId: string): Promise<void> {
  // Set once the row is loaded, so the failure handler can attribute a
  // failure that happened after that point. A failure before it (the row
  // itself not loading) has no owner to tell, and only logs to stdout.
  let profileId: string | null = null;

  try {
    // (a) Load the row.
    const { data: row, error: fetchError } = await supabaseAdmin
      .from("analyses")
      // profile_id is not used by the pipeline itself — it is here so the
      // failure handler below can attach the error to the user who is
      // watching this row, rather than only reaching stdout.
      .select("id, image_key, profile_id")
      .eq("id", analysisId)
      .single<{ id: string; image_key: string; profile_id: string }>();

    if (fetchError || !row) {
      throw new AnalysisFailure(
        "api_error",
        "Analysis row could not be loaded",
      );
    }

    profileId = row.profile_id;

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
        // The payload plus the handful of columns promoted out of it — see
        // analysisResultColumns for what is promoted and what is deliberately
        // left null on a row written by the current prompts.
        ...analysisResultColumns(result),
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
    // The row is about to be marked 'failed', which tells the client watching
    // it that this run is over but not what went wrong anywhere it survives —
    // this is what the Logs tab shows the user afterwards.
    await logAppError(profileId, "analysis", failure.message, {
      analysisId,
      errorCode: failure.code,
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
 * permanently: the user's credit was spent, the UI polled until it timed
 * out, and nothing would ever pick the row up again.
 *
 * Re-running is the right recovery rather than marking the row failed. The
 * image is already durably stored and the credit is already spent, so
 * processing it is what the user actually paid for — and it needs no refund
 * policy. A re-run that fails for a real reason still ends up 'failed'
 * through processAnalysis's own handler, exactly as a first attempt would.
 *
 * Sequential and bounded, and never throws — it is called from a timer.
 */
export async function reclaimStrandedAnalyses(): Promise<number> {
  const cutoff = new Date(Date.now() - STRANDED_AFTER_MS).toISOString();

  // Served by analyses_status_created_at_idx.
  const { data, error } = await supabaseAdmin
    .from("analyses")
    .select("id, source, profile_id, created_at")
    .eq("status", "queued")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_RECLAIM_BATCH)
    .returns<{ id: string; source: string; profile_id: string; created_at: string }[]>();

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
      continue;
    }
    // An interrupted run is the one failure a user has no other way to learn
    // about: nothing was running when it happened, so no request of theirs
    // ever returned an error.
    await logAppError(
      row.profile_id,
      "analysis",
      "The analysis was interrupted and could not be completed",
      { analysisId: row.id, source: row.source },
    );

    // Every other failure path for a fundamentals row (a fetch error, an AI
    // error, a save error — see runFundamentalsAnalysisPipeline in
    // fundamentals-analysis.service.ts) refunds the fundamental_analysis
    // credit it consumed. A row stranded by a process restart never reaches
    // any of those paths — the in-flight promise chain holding that refund
    // died with the process — so without this, an abandoned fundamentals row
    // permanently burns the user's credit for a run that never produced a
    // result.
    if (row.source === "fundamentals") {
      try {
        await callRpc<null>("refund_credits", {
          p_profile_id: row.profile_id,
          p_feature_key: "fundamental_analysis",
          p_ref_analysis_id: row.id,
        });
      } catch (cause) {
        logger.error("failed to refund stranded fundamentals credit", {
          analysisId: row.id,
          cause: String(cause),
        });
      }
    }
  }

  for (const row of rerunnable) {
    // processAnalysis never rejects, by contract, so one bad row cannot stop
    // the sweep from reaching the rest.
    await processAnalysis(row.id);
  }

  return rows.length;
}
