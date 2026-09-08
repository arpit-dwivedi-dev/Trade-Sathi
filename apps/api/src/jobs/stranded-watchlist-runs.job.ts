import { logger } from "../lib/logger.js";
import { reclaimStrandedWatchlistRuns } from "../services/daily-briefing.service.js";

/**
 * Periodic sweep for "Analyze Now" watchlist runs left at 'processing' by a
 * process restart. Same in-process, setInterval-based shape as
 * stranded-analyses.job.ts next door, and the same caveat about more than one
 * API instance sweeping — harmless here since the query only matches
 * 'processing' rows, but would duplicate work.
 *
 * See reclaimStrandedWatchlistRuns for why stranded rows are marked failed
 * rather than re-run.
 */

/** Same window as reclaimStrandedWatchlistRuns' STRANDED_RUN_AFTER_MS. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** Same reasoning as stranded-analyses.job.ts's INITIAL_DELAY_MS. */
const INITIAL_DELAY_MS = 60_000;

/** Guards against overlapping sweeps, same reasoning as stranded-analyses.job.ts. */
let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) {
    logger.info("stranded watchlist run sweep still running; skipping this tick");
    return;
  }

  sweeping = true;
  try {
    await reclaimStrandedWatchlistRuns();
  } catch (cause) {
    // reclaimStrandedWatchlistRuns is not supposed to throw, but this runs on
    // a timer with no caller to catch anything that escapes.
    logger.error("stranded watchlist run sweep threw", { cause: String(cause) });
  } finally {
    sweeping = false;
  }
}

export function startStrandedWatchlistRunSweeper(): void {
  setTimeout(() => {
    void sweep();
    setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info("stranded watchlist run sweeper scheduled", {
    initialDelayMs: INITIAL_DELAY_MS,
    intervalMs: SWEEP_INTERVAL_MS,
  });
}
