export interface ProcessingBriefingLogRow {
  briefing_date: string;
  run_hour_ist: number;
  run_minute_ist: number;
}

/** The API persists briefing_date with the same UTC date representation. */
export function utcDateFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Keeps only processing rows from the date represented by the API's briefing
 * log. Age is intentionally not used here: a large scheduled watchlist can
 * legitimately run longer than the recovery sweep's threshold.
 */
export function currentProcessingSlots(
  rows: readonly ProcessingBriefingLogRow[],
  now = new Date(),
): { hour: number; minute: number }[] {
  const today = utcDateFor(now);
  return rows
    .filter((row) => row.briefing_date === today)
    .map((row) => ({ hour: row.run_hour_ist, minute: row.run_minute_ist }));
}
