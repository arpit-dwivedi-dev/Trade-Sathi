import { logger } from "./logger.js";
import { supabaseAdmin } from "./supabase.js";

/**
 * Persists a user-facing error to app_error_logs, alongside the existing
 * console logger.error call every site already makes — this never replaces
 * that call, it supplements it. logger.error only ever reached stdout, so a
 * background pipeline failure (a scheduled briefing, an Analyze Now run) was
 * invisible to the user who hit it unless someone went looking at server
 * logs. This is what the web app's Logs tab reads.
 *
 * `profileId` is optional: a failure with no resolvable user (a webhook
 * signature check, for instance) still logs to the console via the caller's
 * own logger.error, but has nothing to attach here — app_error_logs' RLS
 * policy only ever returns rows with a matching profile_id, so a null-profile
 * row would never be visible to anyone anyway.
 *
 * Never throws: this runs on failure paths, and a broken write here must not
 * replace or mask the original error.
 */
export async function logAppError(
  profileId: string | null | undefined,
  category: string,
  message: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  if (!profileId) return;
  try {
    const { error } = await supabaseAdmin.from("app_error_logs").insert({
      profile_id: profileId,
      category,
      message,
      detail: detail ?? null,
    });
    if (error) {
      logger.error("failed to write app_error_logs row", { cause: String(error) });
    }
  } catch (cause) {
    logger.error("failed to write app_error_logs row", { cause: String(cause) });
  }
}
