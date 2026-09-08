import { logger } from "../lib/logger.js";
import { reclaimStrandedDailyBriefingLogs } from "../services/daily-briefing.service.js";

/** Periodic recovery for scheduled briefing logs left at 'processing'. */
const SWEEP_INTERVAL_MS = 10 * 60_000;
const INITIAL_DELAY_MS = 60_000;

let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) {
    logger.info("stranded daily briefing sweep still running; skipping this tick");
    return;
  }

  sweeping = true;
  try {
    await reclaimStrandedDailyBriefingLogs();
  } catch (cause) {
    logger.error("stranded daily briefing sweep threw", { cause: String(cause) });
  } finally {
    sweeping = false;
  }
}

export function startStrandedDailyBriefingSweeper(): void {
  setTimeout(() => {
    void sweep();
    setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info("stranded daily briefing sweeper scheduled", {
    initialDelayMs: INITIAL_DELAY_MS,
    intervalMs: SWEEP_INTERVAL_MS,
  });
}
