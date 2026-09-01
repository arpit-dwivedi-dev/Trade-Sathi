import type { Instrument } from "@chartanalyzer/shared";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

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
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    name: row.name,
    instrumentType: row.instrument_type,
  };
}

/** An instrument plus the lowercased fields the matcher compares against. */
interface IndexedInstrument {
  instrument: Instrument;
  symbolLower: string;
  nameLower: string;
}

let cache: IndexedInstrument[] | null = null;
let fetchedAt = 0;
let inFlight: Promise<IndexedInstrument[]> | null = null;

async function fetchAllInstruments(): Promise<IndexedInstrument[]> {
  const indexed: IndexedInstrument[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("instruments")
      .select("id, exchange, symbol, name, instrument_type")
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
  fetchedAt = 0;
  inFlight = null;
}

/**
 * Searches the in-memory catalogue. Ranks exact symbol matches first, then
 * symbol-prefix matches, then name matches — the same ordering the previous
 * three-query ILIKE version produced, now without touching the database.
 *
 * `%` and `_` need no escaping any more: they were only ever special to
 * ILIKE, and are matched literally here, which is what someone typing them
 * into a search box means.
 */
export async function searchInstruments(query: string): Promise<Instrument[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const catalogue = await getCatalogue();

  const exact: Instrument[] = [];
  const prefix: Instrument[] = [];
  const byName: Instrument[] = [];

  for (const entry of catalogue) {
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
