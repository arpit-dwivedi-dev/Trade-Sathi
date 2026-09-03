import { isIndicatorKind, type IndicatorKind } from './indicator-menu';

/**
 * localStorage-backed active-indicator set, kept per instrument + timeframe —
 * same convention as drawing-store.ts.
 *
 * `v2` because indicators are now identified by KLineChart's own names
 * ('MA', 'BOLL', 'RSI') rather than the five app-specific slugs the workspace
 * used to offer.
 */
function storageKey(instrumentId: string, timeframe: string): string {
  return `workspace:indicators:v2:${instrumentId}:${timeframe}`;
}

export function loadIndicators(isBrowser: boolean, instrumentId: string, timeframe: string): IndicatorKind[] {
  if (!isBrowser) return [];
  try {
    const raw = localStorage.getItem(storageKey(instrumentId, timeframe));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as IndicatorKind[]).filter(isIndicatorKind);
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
