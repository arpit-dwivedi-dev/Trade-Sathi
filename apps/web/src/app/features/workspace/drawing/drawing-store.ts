import { isDrawingKind, type Drawing } from './drawing.types';

/**
 * localStorage-backed drawings, kept per instrument + timeframe — a trendline
 * drawn on a 5-minute chart means nothing on the daily chart, so switching
 * either one keeps them apart. No backend/DB involved: this is a per-browser
 * convenience, not synced across devices.
 *
 * The `v2` in the key is the KLineChart migration: anchors used to be stored
 * in the old library's time space (a date string on daily charts, UTC seconds
 * on intraday ones) and are now millisecond timestamps. Bumping the key
 * retires drawings in the old shape instead of restoring them at the wrong
 * place on the chart.
 */
function storageKey(instrumentId: string, timeframe: string): string {
  return `workspace:drawings:v2:${instrumentId}:${timeframe}`;
}

export function loadDrawings(isBrowser: boolean, instrumentId: string, timeframe: string): Drawing[] {
  if (!isBrowser) return [];
  try {
    const raw = localStorage.getItem(storageKey(instrumentId, timeframe));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A stored kind the current build no longer offers would make the chart
    // log an unsupported-overlay warning and draw nothing, so it is dropped
    // here rather than half-restored.
    return (parsed as Drawing[]).filter((drawing) => isDrawingKind(drawing?.kind));
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
