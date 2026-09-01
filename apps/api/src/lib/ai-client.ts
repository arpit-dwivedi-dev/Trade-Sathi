import OpenAI from "openai";
import { env } from "./env.js";

/**
 * The AI provider client.
 *
 * The `openai` SDK is used purely as an OpenAI-compatible Chat Completions HTTP
 * client — the configured provider is not necessarily OpenAI (currently
 * Google Gemini, via its OpenAI-compatible endpoint). No business logic
 * belongs in this module.
 */

/**
 * One attempt, bounded — but bounded generously.
 *
 * The SDK's defaults are a 600s timeout and 2 internal retries, which sat
 * underneath runAnalysisCompletion's own 2-attempt loop: six upstream requests
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

export const aiClient = new OpenAI({
  baseURL: env.aiBaseUrl,
  apiKey: env.aiApiKey,
  timeout: REQUEST_TIMEOUT_MS,
  maxRetries: 0,
});
