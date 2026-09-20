/**
 * localStorage-backed record of the chart the workspace was last showing.
 *
 * The instrument is picked in the shell's top-bar search and handed down as an
 * input, so nothing about it survives a page load on its own — refreshing the
 * tab dropped the user back to an empty workspace and made them search the
 * symbol again. Remembering it here restores the chart they were on.
 *
 * Per-browser convenience, same as drawing-store.ts and indicator-store.ts:
 * nothing goes to the API.
 */
const STORAGE_KEY = 'workspace:last-chart:v1';

export interface LastChart {
  instrument: { id: string; symbol: string; name: string; exchange: string; logoUrl?: string };
  timeframe: string;
}

export function saveLastChart(isBrowser: boolean, chart: LastChart): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chart));
  } catch {
    // Storage full or unavailable (private browsing) — the workspace simply
    // opens empty next time, which is how it behaved before this existed.
  }
}

/** Returns the remembered chart, or null if there is none or it is unreadable. */
export function loadLastChart(isBrowser: boolean): LastChart | null {
  if (!isBrowser) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<LastChart> | null;
    const instrument = parsed?.instrument;
    if (
      !instrument ||
      typeof instrument.id !== 'string' ||
      typeof instrument.symbol !== 'string' ||
      typeof instrument.name !== 'string' ||
      typeof instrument.exchange !== 'string' ||
      typeof parsed.timeframe !== 'string'
    ) {
      return null;
    }
    return { instrument, timeframe: parsed.timeframe };
  } catch {
    return null;
  }
}
