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
export const aiClient = new OpenAI({
  baseURL: env.aiBaseUrl,
  apiKey: env.aiApiKey,
});
