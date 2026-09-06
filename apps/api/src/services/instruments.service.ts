import type { Instrument, MarketCode } from "@chartanalyzer/shared";
import { logger } from "../lib/logger.js";
import { searchYahooSymbols } from "../lib/market-data/yahoo-search-provider.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { resolveInstrumentLogo } from "./instrument-logo.service.js";

/**
 * Markets backed by the imported catalogue (searched in-memory below) vs.
 * ones resolved live through Yahoo Finance search — see
 * yahoo-search-provider.ts. Extending market coverage means adding a market
 * to one of these two lists (or the DB import), not touching the search path
 * itself.
 */
const YAHOO_SEARCH_MARKETS = new Set<MarketCode>(["NASDAQ", "NYSE"]);

const MAX_RESULTS = 15;

/**
 * The catalogue is small (a few thousand NSE/BSE rows, ~150KB) and changes
 * only when the import script runs, but every Supabase round trip from the
 * API costs hundreds of milliseconds — enough that a query returning a single
 * column of a single row is no faster than one scanning the whole table. That
 * made autocomplete pay a full round trip per keystroke batch to search a
 * table small enough to hold in memory, so it is held in memory instead and
 * the round trip disappears from the search path entirely.
 */
const CACHE_TTL_MS = 10 * 60_000;

/**
 * PostgREST caps a response at 1000 rows whatever `limit` asks for, so the
 * catalogue is read in explicit pages. Without this the cache would silently
 * hold only the first page and every instrument past it would vanish from
 * search — a far worse failure than the slow query this replaces.
 */
const PAGE_SIZE = 1000;

interface InstrumentRow {
  id: string;
  exchange: string;
  symbol: string;
  name: string;
  instrument_type: string;
  logo_url: string | null;
  logo_checked_at: string | null;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    name: row.name,
    instrumentType: row.instrument_type,
    logoUrl: row.logo_url ?? undefined,
  };
}

/**
 * An instrument plus the lowercased fields the matcher compares against, and
 * whether a logo lookup has already run for it — `instrument` is the exact
 * object handed back from search, so resolveLogosFor mutating its `logoUrl`
 * in place updates this cache for free, with no separate write-back step.
 */
interface IndexedInstrument {
  instrument: Instrument;
  symbolLower: string;
  nameLower: string;
  logoChecked: boolean;
}

let cache: IndexedInstrument[] | null = null;
let indexById: Map<string, IndexedInstrument> | null = null;
let fetchedAt = 0;
let inFlight: Promise<IndexedInstrument[]> | null = null;

async function fetchAllInstruments(): Promise<IndexedInstrument[]> {
  const indexed: IndexedInstrument[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("instruments")
      .select("id, exchange, symbol, name, instrument_type, logo_url, logo_checked_at")
      // Ordered so paging is stable: without it Postgres may return rows in a
      // different order per page and the pages would overlap or skip.
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Instrument catalogue load failed: ${error.message}`);

    const rows = (data ?? []) as InstrumentRow[];
    for (const row of rows) {
      indexed.push({
        instrument: toInstrument(row),
        symbolLower: row.symbol.toLowerCase(),
        nameLower: row.name.toLowerCase(),
        logoChecked: row.logo_checked_at !== null,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return indexed;
}

/**
 * The catalogue, loaded at most once per TTL. Concurrent misses share one
 * load rather than each starting their own, and a refresh that fails while a
 * previous copy is still held serves the stale copy — a catalogue that is ten
 * minutes out of date is a much better answer for autocomplete than an error,
 * given it only changes when the import script runs.
 */
async function getCatalogue(): Promise<IndexedInstrument[]> {
  if (cache && Date.now() - fetchedAt < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = fetchAllInstruments()
    .then((loaded) => {
      cache = loaded;
      indexById = new Map(loaded.map((entry) => [entry.instrument.id, entry]));
      fetchedAt = Date.now();
      logger.info("instrument catalogue loaded", { count: loaded.length });
      return loaded;
    })
    .catch((cause: unknown) => {
      if (cache) {
        logger.error("instrument catalogue refresh failed; serving stale copy", {
          cause: String(cause),
        });
        return cache;
      }
      throw cause;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Loads the catalogue ahead of the first search. The load itself takes several
 * seconds (a few paged round trips), and without this the first person to type
 * in the dropdown after a restart pays all of it — the one request that would
 * still feel as slow as the version this replaces. Failure is logged and
 * ignored: a warmup is an optimisation, and the next search retries it.
 */
export async function warmInstrumentCache(): Promise<void> {
  try {
    await getCatalogue();
  } catch (cause) {
    logger.error("instrument catalogue warmup failed", { cause: String(cause) });
  }
}

/** Test seam: the catalogue is process-global, which would otherwise leak between tests. */
export function clearInstrumentCache(): void {
  cache = null;
  indexById = null;
  fetchedAt = 0;
  inFlight = null;
}

/**
 * Resolves and persists a logo for whichever of the given instruments don't
 * have one cached yet, mutating each `logoUrl` in place before the caller
 * returns them. A catalogue entry already marked `logoChecked` (found or
 * not) is skipped rather than retried every search — Yahoo-sourced
 * instruments (NASDAQ/NYSE) aren't in the catalogue index and so get
 * rechecked until the next catalogue reload picks up their persisted
 * `logo_checked_at`, at most every CACHE_TTL_MS.
 */
async function resolveLogosFor(instruments: Instrument[]): Promise<void> {
  const pending = instruments.filter((instrument) => {
    if (instrument.logoUrl !== undefined) return false;
    const entry = indexById?.get(instrument.id);
    return !entry?.logoChecked;
  });
  if (pending.length === 0) return;

  await Promise.all(
    pending.map(async (instrument) => {
      const logoUrl = await resolveInstrumentLogo(
        instrument.exchange as MarketCode,
        instrument.symbol,
      );

      const { error } = await supabaseAdmin
        .from("instruments")
        .update({ logo_url: logoUrl, logo_checked_at: new Date().toISOString() })
        .eq("id", instrument.id);
      if (error) {
        logger.error("failed to persist resolved instrument logo", {
          id: instrument.id,
          cause: error.message,
        });
      }

      if (logoUrl) instrument.logoUrl = logoUrl;
      const entry = indexById?.get(instrument.id);
      if (entry) entry.logoChecked = true;
    }),
  );
}

/**
 * Searches the in-memory catalogue, optionally narrowed to one market.
 * Ranks exact symbol matches first, then symbol-prefix matches, then name
 * matches — the same ordering the previous three-query ILIKE version
 * produced, now without touching the database.
 *
 * `%` and `_` need no escaping any more: they were only ever special to
 * ILIKE, and are matched literally here, which is what someone typing them
 * into a search box means.
 */
async function searchCatalogue(query: string, market?: MarketCode): Promise<Instrument[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const catalogue = await getCatalogue();

  const exact: Instrument[] = [];
  const prefix: Instrument[] = [];
  const byName: Instrument[] = [];

  for (const entry of catalogue) {
    if (market && entry.instrument.exchange !== market) continue;
    if (entry.symbolLower === q) {
      exact.push(entry.instrument);
    } else if (entry.symbolLower.startsWith(q)) {
      prefix.push(entry.instrument);
    } else if (entry.nameLower.includes(q)) {
      byName.push(entry.instrument);
    }
    // No early exit: a later exact match still outranks an already-collected
    // name match, so every tier has to be complete before they are merged.
  }

  return [...exact, ...prefix, ...byName].slice(0, MAX_RESULTS);
}

interface UpsertRow {
  id: string;
  exchange: string;
  symbol: string;
  name: string;
  logo_url: string | null;
}

/**
 * Persists Yahoo-search results as real `instruments` rows before returning
 * them, so a NASDAQ/NYSE pick flows through watchlist/workspace/market-chart
 * exactly like an NSE/BSE one — every one of those reads an instrument by
 * its DB id, and a row that only ever existed in a search response would
 * have no id to be read by. `onConflict` on the existing (exchange, symbol)
 * unique index makes this idempotent: the same symbol searched twice reuses
 * its row instead of erroring or duplicating.
 */
async function upsertYahooInstruments(
  results: { exchange: MarketCode; symbol: string; name: string }[],
): Promise<Instrument[]> {
  if (results.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("instruments")
    .upsert(
      results.map((r) => ({
        exchange: r.exchange,
        symbol: r.symbol,
        name: r.name,
        instrument_type: "EQUITY",
      })),
      { onConflict: "exchange,symbol" },
    )
    .select("id, exchange, symbol, name, logo_url");

  if (error) {
    logger.error("failed to persist yahoo search results", { cause: error.message });
    return [];
  }

  return ((data ?? []) as UpsertRow[]).map((row) => ({
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    name: row.name,
    instrumentType: "EQUITY",
    logoUrl: row.logo_url ?? undefined,
  }));
}

/**
 * Instrument search, optionally scoped to one market. NSE/BSE (and any
 * future DB-imported market) search the in-memory catalogue; NASDAQ/NYSE
 * search Yahoo Finance live and persist whatever comes back — see
 * upsertYahooInstruments. Unscoped search (no market) only ever covers the
 * catalogue, since there is no live provider to query without knowing which
 * market to ask.
 */
export async function searchInstruments(
  query: string,
  market?: MarketCode,
): Promise<Instrument[]> {
  let instruments: Instrument[];

  if (market && YAHOO_SEARCH_MARKETS.has(market)) {
    const q = query.trim();
    if (!q) return [];
    const results = await searchYahooSymbols(q);
    instruments = await upsertYahooInstruments(results.filter((r) => r.exchange === market));
  } else {
    instruments = await searchCatalogue(query, market);
  }

  await resolveLogosFor(instruments);
  return instruments;
}
