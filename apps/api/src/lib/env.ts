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

function requireNumberEnv(name: string): number {
  const value = Number(requireEnv(name));
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return value;
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

  // AI provider config. The configured provider is expected to support the
  // OpenAI-compatible Chat Completions shape used here; provider-specific
  // differences must not be introduced unless a future provider actually
  // requires them.
  aiBaseUrl: requireEnv("AI_BASE_URL"),
  aiApiKey: requireEnv("AI_API_KEY"),
  aiModel: requireEnv("AI_MODEL"),
  // USD per million tokens for the currently configured model. Kept in config,
  // never hardcoded in code: provider pricing changes and a baked-in number
  // goes stale silently.
  aiInputCostPerM: requireNumberEnv("AI_INPUT_COST_PER_M"),
  aiOutputCostPerM: requireNumberEnv("AI_OUTPUT_COST_PER_M"),
  // Completion token budget per analysis request. Config, not a constant,
  // because the right value depends entirely on which model is configured —
  // see the comment at its use site in services/ai-analysis.service.ts.
  aiMaxTokens: requireNumberEnv("AI_MAX_TOKENS"),
};
