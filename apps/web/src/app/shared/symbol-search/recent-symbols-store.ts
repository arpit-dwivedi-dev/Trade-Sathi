import type { Instrument } from '@tradesathi/shared';

/**
 * localStorage-backed list of the last few instruments picked in the symbol
 * search, newest first — same convention as the workspace's indicator-store.ts.
 * Browser-only and per device; nothing goes to the API.
 */
const STORAGE_KEY = 'symbol-search:recent:v1';
export const MAX_RECENT_SYMBOLS = 5;

function isInstrument(value: unknown): value is Instrument {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && typeof v['symbol'] === 'string'
    && typeof v['name'] === 'string' && typeof v['exchange'] === 'string';
}

export function loadRecentSymbols(isBrowser: boolean): Instrument[] {
  if (!isBrowser) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isInstrument).slice(0, MAX_RECENT_SYMBOLS);
  } catch {
    return [];
  }
}

/** Moves the instrument to the front, de-duplicated by id, capped at MAX_RECENT_SYMBOLS. */
export function pushRecentSymbol(isBrowser: boolean, instrument: Instrument): Instrument[] {
  const next = [instrument, ...loadRecentSymbols(isBrowser).filter((i) => i.id !== instrument.id)]
    .slice(0, MAX_RECENT_SYMBOLS);
  if (!isBrowser) return next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable — recents are a convenience, not state we must keep.
  }
  return next;
}
