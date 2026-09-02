import type { Drawing } from './drawing.types';

/**
 * localStorage-backed drawings, kept per instrument + timeframe — a trendline
 * drawn on a 5-minute chart means nothing on the daily chart, so switching
 * either one keeps them apart. No backend/DB involved: this is a per-browser
 * convenience, not synced across devices.
 */
function storageKey(instrumentId: string, timeframe: string): string {
  return `workspace:drawings:${instrumentId}:${timeframe}`;
}

export function loadDrawings(isBrowser: boolean, instrumentId: string, timeframe: string): Drawing[] {
  if (!isBrowser) return [];
  try {
    const raw = localStorage.getItem(storageKey(instrumentId, timeframe));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Drawing[]) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(
  isBrowser: boolean,
  instrumentId: string,
  timeframe: string,
  drawings: Drawing[],
): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(storageKey(instrumentId, timeframe), JSON.stringify(drawings));
  } catch {
    // Storage full or unavailable (private browsing) — drawings simply stop
    // persisting for this session rather than breaking the workspace.
  }
}
