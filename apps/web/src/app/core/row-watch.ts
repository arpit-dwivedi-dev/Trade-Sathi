import { REALTIME_SUBSCRIBE_STATES, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Decides *when* to re-check an in-flight row, for the three places that wait
 * on one: AnalyzeService.pollAnalysis (an upload, watched by analyses id),
 * LiveService.awaitAnalysis (a live run, watched by instrument and start time)
 * and Watchlist.watchRun (an Analyze Now run, watched by run id).
 *
 * It deliberately owns none of the checking. Each caller keeps its own query,
 * its own timeout, and its own idea of what "settled" means, and passes a
 * `check` this calls. All that is shared is the part both got wrong in the same
 * way: a fixed 2-second interval meant the result sat finished in the database
 * for up to two seconds before the UI noticed, and roughly 45 wide-row queries
 * were spent per analysis waiting for a row nobody had written yet.
 *
 * So the interval is now the fallback rather than the mechanism. Supabase
 * Realtime pushes the row the moment it is written, and the timer drops to a
 * slow safety net for as long as that subscription is actually live.
 */

/**
 * Cadence while Realtime is not carrying the updates — an unchanged 2 seconds,
 * so a browser that cannot hold the socket (a blocked WebSocket, a dropped
 * connection) behaves exactly as it did before this existed.
 */
const FALLBACK_INTERVAL_MS = 2_000;

/**
 * Cadence once the subscription is live. Not longer than this despite Realtime
 * making it near-redundant: each caller detects its own timeout inside `check`,
 * so this interval is also the granularity of "give up", and a 30-second net
 * would leave a user watching a spinner half a minute past the deadline.
 */
const SAFETY_NET_INTERVAL_MS = 5_000;

export interface RowWatch {
  /** Idempotent: safe to call from a cancel path that may already have run. */
  stop(): void;
}

/**
 * Starts watching, and runs `check` on the next microtask.
 *
 * `table` is a public schema table that must be on the supabase_realtime
 * publication — a table that is not on it produces no events at all rather
 * than an error, which degrades silently into the fallback cadence.
 *
 * `filter` is a PostgREST filter on that table (e.g. `id=eq.<uuid>`).
 * Realtime applies RLS, so a subscription only ever delivers rows the signed-in
 * user could have selected anyway.
 *
 * `channelName` must be unique per watch — two channels sharing a name on one
 * client collide.
 */
export function startRowWatch(
  client: SupabaseClient,
  channelName: string,
  table: string,
  filter: string,
  check: () => void,
): RowWatch {
  let stopped = false;

  /** Every path into `check` goes through here, so a stopped watch is inert. */
  const safeCheck = (): void => {
    if (stopped) return;
    check();
  };

  let timer: ReturnType<typeof setInterval> | null = setInterval(
    safeCheck,
    FALLBACK_INTERVAL_MS,
  );

  const setCadence = (intervalMs: number): void => {
    if (stopped) return;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(safeCheck, intervalMs);
  };

  const channel = client
    .channel(channelName)
    .on(
      'postgres_changes',
      // Both an INSERT (the live pipeline writes a finished row) and an UPDATE
      // (the upload pipeline fills in a row that started as 'queued') are worth
      // waking for, so this listens to everything the filter matches rather
      // than naming one event.
      { event: '*', schema: 'public', table, filter },
      () => safeCheck(),
    )
    .subscribe((status) => {
      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
        setCadence(SAFETY_NET_INTERVAL_MS);
        // The row may well have been written between the initial check and the
        // subscription going live — that window would otherwise not be covered
        // by either mechanism.
        safeCheck();
        return;
      }
      // Everything else (CHANNEL_ERROR, TIMED_OUT, CLOSED) means updates are no
      // longer arriving, so the timer goes back to carrying the load alone.
      setCadence(FALLBACK_INTERVAL_MS);
    });

  // Queued rather than called straight through, so this function has returned
  // and the caller has assigned the handle before any check can run. Callers
  // stop the watch from inside their own check (that is how they settle), and a
  // check that ran during construction would be asking them to stop a watch
  // they have not been given yet — leaving the timer running forever. The delay
  // is a microtask, so nothing waits on it.
  queueMicrotask(safeCheck);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      void client.removeChannel(channel);
    },
  };
}
