import { logger } from "../lib/logger.js";
import { reclaimStrandedAnalyses } from "../services/ai-analysis.service.js";

/**
 * Periodic sweep for analyses left at 'queued' by a process restart.
 *
 * Same in-process, setInterval-based shape as the daily-briefing scheduler
 * next door, and for the same reason: this project has no job queue and the
 * spec says not to introduce one. It carries the same limitation — running
 * more than one API instance would have every instance sweeping — which is
 * harmless here (re-dispatching an already-'complete' row is impossible; the
 * query only matches 'queued') but would duplicate work.
 *
 * See reclaimStrandedAnalyses for why stranded rows are re-run rather than
 * marked failed.
 */

/**
 * How often to look. The stranded window itself is ten minutes (see
 * STRANDED_AFTER_MS), so sweeping on the same cadence means a row is picked up
 * within twenty minutes of being stranded without polling the table for no
 * reason in between.
 */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Delay before the first sweep. A restart is exactly when stranded rows appear,
 * but it is also when the process is busiest, and the rows are not going
 * anywhere — so the first sweep waits for the server to settle rather than
 * competing with the requests arriving as it comes up.
 */
const INITIAL_DELAY_MS = 60_000;

/**
 * Guards against overlapping sweeps. A sweep re-runs up to twenty analyses
 * sequentially, each of which can take a minute, so it can comfortably outlast
 * the interval — without this, the next tick would start a second sweep that
 * re-dispatches the same rows the first one is still working through.
 */
let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) {
    logger.info("stranded analysis sweep still running; skipping this tick");
    return;
  }

  sweeping = true;
  try {
    await reclaimStrandedAnalyses();
  } catch (cause) {
    // reclaimStrandedAnalyses is not supposed to throw, but this runs on a
    // timer with no caller to catch anything that escapes.
    logger.error("stranded analysis sweep threw", { cause: String(cause) });
  } finally {
    sweeping = false;
  }
}

export function startStrandedAnalysisSweeper(): void {
  setTimeout(() => {
    void sweep();
    setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info("stranded analysis sweeper scheduled", {
    initialDelayMs: INITIAL_DELAY_MS,
    intervalMs: SWEEP_INTERVAL_MS,
  });
}
