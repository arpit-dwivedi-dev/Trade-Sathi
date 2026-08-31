import { logger } from "../lib/logger.js";
import { runDailyBriefingForAllUsers } from "../services/daily-briefing.service.js";

const IST_OFFSET_MINUTES = 5.5 * 60;

/**
 * In-process scheduler: a single setTimeout that fires at the top of every IST
 * hour and reschedules itself, rather than a cron library or job queue — this
 * project has neither, and the spec explicitly says not to introduce a queue
 * unless one already exists.
 *
 * It ticks hourly (rather than once at a configured hour) because a watchlist
 * item now carries its own scheduled_hour_ist; each tick processes only the
 * items due at that hour, and an hour with nothing due is a cheap no-op query.
 * DAILY_BRIEFING_RUN_HOUR_IST still decides the hour for items that have no
 * per-item setting, so a deployment that configures nothing behaves as before.
 *
 * KNOWN LIMITATION (documented per spec, not a bug to silently work around):
 * this requires the API process to stay running continuously. If the process
 * restarts, the next run only fires at the next hour boundary from whenever
 * it comes back up — a missed hour is not backfilled. daily_briefing_log still
 * prevents any duplicate email if the process restarts mid-run and the job
 * fires again in the same hour.
 */
/**
 * Milliseconds to the next IST hour boundary. IST is UTC+5:30, so those
 * boundaries fall on UTC minute 30, not on the UTC hour — waking at :00 UTC
 * would run every item half an hour early. The extra second is slack so a
 * timer that fires a few milliseconds shy of the boundary still reads the
 * hour it was scheduled for, not the previous one.
 */
function msUntilNextIstHour(): number {
  const now = new Date();
  let deltaMinutes = (30 - now.getUTCMinutes() + 60) % 60;
  if (deltaMinutes === 0) deltaMinutes = 60;
  return (
    deltaMinutes * 60 * 1000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds() + 1000
  );
}

function currentIstHour(): number {
  const now = new Date();
  const istMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MINUTES;
  return Math.floor((istMinutes % (24 * 60)) / 60);
}

function scheduleNext(): void {
  const delay = msUntilNextIstHour();
  logger.info("daily briefing tick scheduled", { delayMs: delay });

  setTimeout(() => {
    // Read the hour inside the callback, not when scheduling: the timer fires
    // after the boundary has passed, so this is the hour whose items are due.
    const runHourIst = currentIstHour();
    void runDailyBriefingForAllUsers(runHourIst)
      .catch((cause) => {
        logger.error("scheduled daily briefing run threw", {
          runHourIst,
          cause: String(cause),
        });
      })
      .finally(() => {
        // Recompute from the current time rather than adding a fixed hour —
        // scheduleNext() naturally lands back on the next hour boundary,
        // avoiding cumulative drift. A single failed run must not silently
        // end the recurring schedule either way.
        scheduleNext();
      });
  }, delay);
}

export function startDailyBriefingScheduler(): void {
  scheduleNext();
}
