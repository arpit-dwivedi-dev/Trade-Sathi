import { logger } from "../lib/logger.js";
import { runDailyBriefingForAllUsers } from "../services/daily-briefing.service.js";

const IST_OFFSET_MINUTES = 5.5 * 60;

/**
 * In-process scheduler: a single setTimeout that fires at the top of every IST
 * minute and reschedules itself, rather than a cron library or job queue —
 * this project has neither, and the spec explicitly says not to introduce a
 * queue unless one already exists.
 *
 * It ticks every minute (rather than hourly) because a watchlist item now
 * carries its own scheduled_hour_ist + scheduled_minute_ist; each tick
 * processes only the items due at that exact minute, and a minute with
 * nothing due is a cheap no-op query. DAILY_BRIEFING_RUN_HOUR_IST still
 * decides the hour (on the hour, i.e. minute 0) for items that have no
 * per-item setting, so a deployment that configures nothing behaves as
 * before.
 *
 * KNOWN LIMITATION (documented per spec, not a bug to silently work around):
 * this requires the API process to stay running continuously. If the process
 * restarts, the next run only fires at the next minute boundary from whenever
 * it comes back up — a missed minute is not backfilled. daily_briefing_log
 * still prevents any duplicate email if the process restarts mid-run and the
 * job fires again in the same minute.
 */
/**
 * Milliseconds to the next IST minute boundary. IST is UTC+5:30, so its
 * minute boundaries fall 30 seconds off the UTC minute boundary... no —
 * IST minutes and UTC minutes are the same length and start at the same
 * instant (the 5:30 offset is whole minutes), so this is simply the delay to
 * the next UTC minute boundary. The extra second is slack so a timer that
 * fires a few milliseconds shy of the boundary still reads the minute it was
 * scheduled for, not the previous one.
 */
function msUntilNextIstMinute(): number {
  const now = new Date();
  return 60 * 1000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds() + 1000;
}

function currentIstHourAndMinute(): { hour: number; minute: number } {
  const now = new Date();
  const istMinutesOfDay =
    (now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MINUTES) % (24 * 60);
  return {
    hour: Math.floor(istMinutesOfDay / 60),
    minute: Math.floor(istMinutesOfDay % 60),
  };
}

function scheduleNext(): void {
  const delay = msUntilNextIstMinute();
  logger.info("daily briefing tick scheduled", { delayMs: delay });

  setTimeout(() => {
    // Read the time inside the callback, not when scheduling: the timer fires
    // after the boundary has passed, so this is the minute whose items are
    // due.
    const { hour: runHourIst, minute: runMinuteIst } = currentIstHourAndMinute();
    void runDailyBriefingForAllUsers(runHourIst, runMinuteIst)
      .catch((cause) => {
        logger.error("scheduled daily briefing run threw", {
          runHourIst,
          runMinuteIst,
          cause: String(cause),
        });
      })
      .finally(() => {
        // Recompute from the current time rather than adding a fixed minute —
        // scheduleNext() naturally lands back on the next minute boundary,
        // avoiding cumulative drift. A single failed run must not silently
        // end the recurring schedule either way.
        scheduleNext();
      });
  }, delay);
}

export function startDailyBriefingScheduler(): void {
  scheduleNext();
}
