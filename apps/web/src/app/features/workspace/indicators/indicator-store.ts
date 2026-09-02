import type { IndicatorKind } from './indicator-menu';

/** localStorage-backed active-indicator set, kept per instrument + timeframe — same convention as drawing-store.ts. */
function storageKey(instrumentId: string, timeframe: string): string {
  return `workspace:indicators:${instrumentId}:${timeframe}`;
}

export function loadIndicators(isBrowser: boolean, instrumentId: string, timeframe: string): IndicatorKind[] {
  if (!isBrowser) return [];
  try {
    const raw = localStorage.getItem(storageKey(instrumentId, timeframe));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as IndicatorKind[]) : [];
  } catch {
    return [];
  }
}

export function saveIndicators(
  isBrowser: boolean,
  instrumentId: string,
  timeframe: string,
  kinds: readonly IndicatorKind[],
): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(storageKey(instrumentId, timeframe), JSON.stringify(kinds));
  } catch {
    // Storage full or unavailable — see drawing-store.ts's identical tradeoff.
  }
}
