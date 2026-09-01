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
 * One attempt, bounded. The SDK's defaults are a 600s timeout and 2 internal
 * retries, which sat underneath runAnalysisCompletion's own 2-attempt loop:
 * six upstream requests and up to ~20 minutes before the promise settled,
 * long after the browser stopped waiting (90s for an upload, 180s for a live
 * run) and left the analyses row stranded at 'queued'.
 *
 * maxRetries: 0 so there is exactly ONE retry policy, and it is the one in
 * ai-analysis.service.ts that can log each attempt and back off between them.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export const aiClient = new OpenAI({
  baseURL: env.aiBaseUrl,
  apiKey: env.aiApiKey,
  timeout: REQUEST_TIMEOUT_MS,
  maxRetries: 0,
});
