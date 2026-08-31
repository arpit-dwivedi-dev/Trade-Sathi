import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { runDailyBriefingForAllUsers } from "../services/daily-briefing.service.js";

const IST_OFFSET_MINUTES = 5.5 * 60;

/**
 * In-process scheduler: a single setTimeout that fires at the configured IST
 * hour and reschedules itself, rather than a cron library or job queue — this
 * project has neither, and the spec explicitly says not to introduce a queue
 * unless one already exists.
 *
 * KNOWN LIMITATION (documented per spec, not a bug to silently work around):
 * this requires the API process to stay running continuously. If the process
 * restarts, the next run only fires at the next scheduled time from whenever
 * it comes back up — a missed run is not backfilled. daily_briefing_log still
 * prevents any duplicate email if the process restarts mid-run and the job
 * fires again the same day.
 */
function msUntilNextRun(): number {
  const now = new Date();
  const nowIstMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MINUTES;
  const targetIstMinutes = env.dailyBriefingRunHourIst * 60;

  let deltaMinutes = targetIstMinutes - nowIstMinutes;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;

  return deltaMinutes * 60 * 1000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
}

function scheduleNext(): void {
  const delay = msUntilNextRun();
  logger.info("daily briefing scheduled", { delayMs: delay });

  setTimeout(() => {
    void runDailyBriefingForAllUsers()
      .catch((cause) => {
        logger.error("scheduled daily briefing run threw", { cause: String(cause) });
      })
      .finally(() => {
        // Recompute from the current time rather than adding a fixed 24h —
        // scheduleNext() naturally lands back on the next occurrence of the
        // configured hour, avoiding cumulative drift. A single failed run
        // must not silently end the recurring schedule either way.
        scheduleNext();
      });
  }, delay);
}

export function startDailyBriefingScheduler(): void {
  scheduleNext();
}
