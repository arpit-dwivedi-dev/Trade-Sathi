import { supabaseAdmin } from "../lib/supabase.js";

export interface EnabledWatchlistItem {
  watchlistItemId: string;
  instrumentId: string;
  instrumentKey: string;
  exchange: string;
  symbol: string;
  name: string;
}

interface EnabledWatchlistRow {
  id: string;
  instrument_id: string | null;
  instruments: {
    id: string;
    exchange: string;
    symbol: string;
    name: string;
  } | null;
}

/**
 * Watchlist add/remove/enable-toggle themselves are plain client-side CRUD
 * against Supabase under RLS (see apps/web's watchlist component and
 * 20260831160000_watchlist_daily_analysis_flag.sql's column-scoped UPDATE
 * grant) — there is no backend route for those, and this task does not add
 * one. This service exists only for the one read the daily-briefing job
 * needs server-side: which profiles have symbols enabled for automated
 * analysis, and which resolved instrument (as a Yahoo Finance ticker symbol)
 * each one points at.
 */

// Yahoo Finance ticker suffixes per exchange. Only NSE/BSE are supported —
// the only exchanges this app's instrument search covers today; extend this
// map rather than guessing a suffix if a new exchange is ever added.
const YAHOO_EXCHANGE_SUFFIX: Record<string, string> = {
  NSE: ".NS",
  BSE: ".BO",
};

function toYahooSymbol(exchange: string, symbol: string): string | null {
  const suffix = YAHOO_EXCHANGE_SUFFIX[exchange.toUpperCase()];
  return suffix ? `${symbol}${suffix}` : null;
}

/** Distinct profile ids with at least one watchlist item enabled for daily analysis. */
export async function listProfilesWithEnabledWatchlist(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("watchlist_items")
    .select("profile_id")
    .eq("enabled_for_daily_analysis", true);

  if (error) throw error;

  return [...new Set((data ?? []).map((row) => row.profile_id as string))];
}

/**
 * A profile's enabled watchlist items, resolved to a real instrument with a
 * supported exchange. Items whose instrument is unresolved or on an exchange
 * Yahoo Finance mapping doesn't cover are silently excluded — there is no
 * market-data identity to fetch with, so they cannot participate in automated
 * analysis at all (not a per-run failure to report, since there was never
 * anything to run).
 */
export async function getEnabledWatchlistItems(
  profileId: string,
): Promise<EnabledWatchlistItem[]> {
  const { data, error } = await supabaseAdmin
    .from("watchlist_items")
    .select("id, instrument_id, instruments(id, exchange, symbol, name)")
    .eq("profile_id", profileId)
    .eq("enabled_for_daily_analysis", true);

  if (error) throw error;

  const rows = (data ?? []) as unknown as EnabledWatchlistRow[];
  const items: EnabledWatchlistItem[] = [];
  for (const row of rows) {
    const instrument = row.instruments;
    if (!instrument) continue;
    const yahooSymbol = toYahooSymbol(instrument.exchange, instrument.symbol);
    if (!yahooSymbol) continue;
    items.push({
      watchlistItemId: row.id,
      instrumentId: instrument.id,
      instrumentKey: yahooSymbol,
      exchange: instrument.exchange,
      symbol: instrument.symbol,
      name: instrument.name,
    });
  }
  return items;
}

/**
 * A single watchlist item, scoped to the requesting profile — used by the
 * "Analyze Now" endpoint. Deliberately ignores enabled_for_daily_analysis:
 * that flag only controls the scheduled job, not an explicit user-triggered
 * request for the same item. Returns null when the item doesn't exist, isn't
 * owned by this profile, or has no instrument on a Yahoo-supported exchange
 * — the route maps all three to the same "not found" response, since none of
 * them is this profile's business to distinguish from each other.
 */
export async function getWatchlistItemForProfile(
  profileId: string,
  watchlistItemId: string,
): Promise<EnabledWatchlistItem | null> {
  const { data, error } = await supabaseAdmin
    .from("watchlist_items")
    .select("id, instrument_id, instruments(id, exchange, symbol, name)")
    .eq("profile_id", profileId)
    .eq("id", watchlistItemId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as EnabledWatchlistRow;
  const instrument = row.instruments;
  if (!instrument) return null;
  const yahooSymbol = toYahooSymbol(instrument.exchange, instrument.symbol);
  if (!yahooSymbol) return null;

  return {
    watchlistItemId: row.id,
    instrumentId: instrument.id,
    instrumentKey: yahooSymbol,
    exchange: instrument.exchange,
    symbol: instrument.symbol,
    name: instrument.name,
  };
}
