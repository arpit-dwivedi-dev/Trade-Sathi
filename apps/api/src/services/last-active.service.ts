import { logger } from "../lib/logger.js";
import type { SessionGeo } from "@tradesathi/shared";
import { callRpc } from "../lib/supabase.js";

/**
 * At most one write per user per window. Matches the web app's heartbeat
 * (core/presence.service.ts), so an open tab stays "online" in the Admin
 * panel — whose online window (admin_user_counts) is three of these.
 */
const TOUCH_INTERVAL_MS = 60 * 1000;

/**
 * profileId → when this process last stamped it. In-process like the other
 * caches here (see CLAUDE.md's single-instance note); a second instance would
 * only mean an extra write per window, never a wrong value.
 */
const lastTouched = new Map<string, number>();

/**
 * Stamps profiles.last_active_at — the Admin panel's signal that a signed-in
 * user actually used the app — and, when the IP resolved, their last-seen
 * (and first time, first-seen) location. Never throws: activity tracking
 * must not fail the request that triggered it.
 */
export async function touchLastActive(
  profileId: string,
  geo: SessionGeo | null | undefined,
  now: number = Date.now(),
): Promise<void> {
  const previous = lastTouched.get(profileId);
  if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(profileId, now);

  try {
    await callRpc("touch_profile_activity", {
      p_profile_id: profileId,
      p_country: geo?.country ?? null,
      p_region: geo?.region ?? null,
      p_city: geo?.city ?? null,
    });
  } catch (cause) {
    // Forget the stamp so the next request retries instead of waiting a window.
    lastTouched.delete(profileId);
    logger.warn("profile activity update failed", { profileId, cause: String(cause) });
  }
}
