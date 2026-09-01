import OpenAI from "openai";
import { env, type AiProviderConfig } from "./env.js";

/**
 * The AI provider clients.
 *
 * The `openai` SDK is used purely as an OpenAI-compatible Chat Completions HTTP
 * client — the configured providers are not necessarily OpenAI (currently
 * Google Gemini, via its OpenAI-compatible endpoint, with DeepSeek behind it).
 * No business logic belongs in this module: which client to try, in what order,
 * and what counts as a failure worth falling back on all live in
 * services/ai-analysis.service.ts.
 */

/**
 * One attempt, bounded — but bounded generously.
 *
 * The SDK's defaults are a 600s timeout and 2 internal retries, which sat
 * underneath runAnalysisCompletion's own attempt loop: six upstream requests
 * and up to ~20 minutes before the promise settled, long after the browser
 * stopped waiting (90s for an upload, 180s for a live run) and left the
 * analyses row stranded at 'queued'.
 *
 * The value is measured, not guessed, and the measurement is the whole point:
 * a 250-candle series analysis on the configured model takes ~54s of wall
 * clock for ~350 output tokens. A timeout anywhere near that number does not
 * bound a hung request, it fails a working one — 60s was tried and turned a
 * normal analysis into an intermittent failure. This leaves better than 2x
 * headroom over the observed time while still being far short of the ten
 * minutes the default would have allowed.
 *
 * maxRetries: 0 so there is exactly ONE retry policy, and it is the one in
 * ai-analysis.service.ts, which can log each attempt, back off between them,
 * and — critically — decline to retry at all when the first attempt is what
 * timed out.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/** A configured provider paired with the client that talks to it. */
export interface AiProvider extends AiProviderConfig {
  client: OpenAI;
}

/**
 * The provider chain in priority order: index 0 is primary, the rest are
 * fallbacks. Clients are constructed once at startup — an OpenAI instance is
 * just config plus an HTTP agent, so holding one per configured provider costs
 * nothing and keeps the failover path free of per-request setup.
 */
export const aiProviders: AiProvider[] = env.aiProviders.map((provider) => ({
  ...provider,
  client: new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  }),
}));
