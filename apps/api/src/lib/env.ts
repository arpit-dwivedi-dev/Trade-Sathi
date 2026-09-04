import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Environment loading lives here, not in an npm script's flags, so dev
// (tsx watch src/index.ts) and production (node dist/index.js, Docker, …)
// resolve config identically.
//
// Resolved relative to this module rather than cwd, so it works from any
// working directory; src/lib/env.ts and dist/lib/env.js both sit two levels
// under apps/api. In production the platform injects real env vars and there
// is usually no file to read, so loading is skipped there entirely.
// process.loadEnvFile (Node >= 20.12, and this repo requires >= 22) never
// overwrites an already-set variable, so real env always wins over the file.
if (process.env["NODE_ENV"] !== "production") {
  const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Optional integer env within an inclusive range, failing at startup rather
 * than passing a bad value downstream. Deliberately strict: a NaN hour would
 * make the scheduler's msUntilNextRun() return NaN, and setTimeout(fn, NaN)
 * fires immediately and re-arms in its finally block — a tight loop re-running
 * the whole job. A crash on boot is far easier to diagnose than that.
 */
/** Optional boolean env, "false" (case-insensitive) is the only way to turn
 *  a default-true flag off; anything else, including unset, keeps the
 *  default. */
function optionalBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() !== "false";
}

function optionalIntEnvInRange(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * One entry in the AI provider fallback chain (AI_PROVIDERS).
 *
 * Every provider is expected to speak the OpenAI-compatible Chat Completions
 * shape used in services/ai-analysis.service.ts; provider-specific request
 * differences must not be introduced unless a future provider actually
 * requires them. Model id, token budget and pricing are per-provider because
 * none of them survive a switch: DeepSeek's rates are not Gemini's, and a
 * reasoning model's max_tokens is not a non-reasoning one's.
 */
export interface AiProviderConfig {
  /** Human label, used only in logs to say which provider served a call. */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** USD per million tokens. Config, never hardcoded: provider pricing
   *  changes and a baked-in number goes stale silently. */
  inputCostPerM: number;
  outputCostPerM: number;
  /** Completion token budget per request — see the comment at its use site in
   *  services/ai-analysis.service.ts. */
  maxTokens: number;
  /** Whether the model accepts image_url content parts. Text-only models
   *  (DeepSeek's chat models, for one) cannot serve the uploaded-screenshot
   *  path at all, so the visual analysis chain skips them rather than
   *  spending a doomed request; the candle-series path still uses them. */
  supportsVision: boolean;
}

function providerField(raw: Record<string, unknown>, index: number, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AI_PROVIDERS[${index}].${key} must be a non-empty string`);
  }
  return value;
}

function providerNumberField(raw: Record<string, unknown>, index: number, key: string): number {
  const value = Number(raw[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`AI_PROVIDERS[${index}].${key} must be a number`);
  }
  return value;
}

/**
 * Parses AI_PROVIDERS: a JSON array of provider objects, in priority order.
 *
 * Validated eagerly at startup rather than at the first analysis, because the
 * whole point of the chain is that a user never sees a provider outage — a
 * malformed fallback that only surfaces once the primary is already down
 * defeats it entirely.
 */
function parseAiProviders(): AiProviderConfig[] {
  const raw = requireEnv("AI_PROVIDERS");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Environment variable AI_PROVIDERS must be valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Environment variable AI_PROVIDERS must be a non-empty JSON array");
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`AI_PROVIDERS[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;

    return {
      name: typeof item["name"] === "string" && item["name"].length > 0
        ? item["name"]
        : `provider-${index}`,
      baseUrl: providerField(item, index, "baseUrl"),
      apiKey: providerField(item, index, "apiKey"),
      model: providerField(item, index, "model"),
      inputCostPerM: providerNumberField(item, index, "inputCostPerM"),
      outputCostPerM: providerNumberField(item, index, "outputCostPerM"),
      maxTokens: providerNumberField(item, index, "maxTokens"),
      // Defaults to true: the existing primary is a vision model, and an
      // omitted flag on a text-only provider fails loudly on the visual path
      // rather than silently skipping it everywhere.
      supportsVision: item["supportsVision"] !== false,
    };
  });
}

export const env = {
  port: Number(process.env["PORT"] ?? 3000),
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  razorpayKeyId: requireEnv("RAZORPAY_KEY_ID"),
  razorpayKeySecret: requireEnv("RAZORPAY_KEY_SECRET"),
  // A DIFFERENT secret from RAZORPAY_KEY_SECRET: this one is generated when
  // the webhook is configured in the Razorpay dashboard, and is used only to
  // verify inbound webhook signatures.
  razorpayWebhookSecret: requireEnv("RAZORPAY_WEBHOOK_SECRET"),

  // Ordered AI provider chain — first entry is primary, the rest are
  // fallbacks tried in order when one fails. See parseAiProviders above.
  aiProviders: parseAiProviders(),

  resendApiKey: requireEnv("RESEND_API_KEY"),
  // The verified "From" address/display name Resend sends the daily briefing
  // from, e.g. "ChartAnalyzer <briefing@yourdomain.com>".
  resendFromAddress: requireEnv("RESEND_FROM_ADDRESS"),

  // Shared-secret gate for the internal manual-trigger endpoint
  // (routes/internal.route.ts). There is no admin-role system yet, so this is
  // the whole access control for that route — treat it like a password.
  internalOpsToken: requireEnv("INTERNAL_OPS_TOKEN"),

  // Hour of day, in IST, the daily briefing job runs at. Numeric env rather
  // than a hardcoded constant so the run time can be tuned without a deploy.
  // Defaults to 8 (08:00 IST) — no prior "existing configured morning time"
  // exists in this project yet to match.
  dailyBriefingRunHourIst: optionalIntEnvInRange("DAILY_BRIEFING_RUN_HOUR_IST", 8, 0, 23),

  // Master switch for the fundamentals verification middle layer (see
  // services/fundamentals-verification.service.ts). Defaults on: even with
  // no search provider configured, it still runs the deterministic
  // (missing/stale/arithmetic) checks and never blocks or slows the
  // pipeline on failure, so there is no safety reason to default it off.
  fundamentalsVerificationEnabled: optionalBoolEnv("FUNDAMENTALS_VERIFICATION_ENABLED", true),

  // Base URL of a self-hosted SearXNG instance used as the pluggable search
  // fallback for authoritative-source corroboration. Optional — when unset,
  // the verification layer still runs its deterministic checks, it just has
  // no way to enrich or correct a flagged field, and marks it unverifiable.
  searxngBaseUrl: process.env["SEARXNG_BASE_URL"] || null,
};
