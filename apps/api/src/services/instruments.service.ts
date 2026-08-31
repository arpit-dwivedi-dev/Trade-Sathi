import type { Instrument } from "@chartanalyzer/shared";
import { supabaseAdmin } from "../lib/supabase.js";

const MAX_RESULTS = 15;

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

/**
 * Searches the local `instruments` table only — never an external API on
 * every keystroke. Ranks exact symbol matches first, then symbol-prefix
 * matches, then name matches, using ILIKE against the trigram-indexed
 * columns from the instruments migration.
 */
export async function searchInstruments(query: string): Promise<Instrument[]> {
  const q = query.trim();
  if (!q) return [];

  const escaped = q.replace(/[%_]/g, (c) => `\\${c}`);

  const [exact, prefix, byName] = await Promise.all([
    supabaseAdmin
      .from("instruments")
      .select("id, exchange, symbol, name, instrument_type")
      .ilike("symbol", escaped)
      .limit(MAX_RESULTS),
    supabaseAdmin
      .from("instruments")
      .select("id, exchange, symbol, name, instrument_type")
      .ilike("symbol", `${escaped}%`)
      .limit(MAX_RESULTS),
    supabaseAdmin
      .from("instruments")
      .select("id, exchange, symbol, name, instrument_type")
      .ilike("name", `%${escaped}%`)
      .limit(MAX_RESULTS),
  ]);

  for (const result of [exact, prefix, byName]) {
    if (result.error) throw new Error(`Instrument search failed: ${result.error.message}`);
  }

  const seen = new Set<string>();
  const merged: Instrument[] = [];
  for (const rows of [exact.data ?? [], prefix.data ?? [], byName.data ?? []]) {
    for (const row of rows as InstrumentRow[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(toInstrument(row));
      if (merged.length >= MAX_RESULTS) return merged;
    }
  }
  return merged;
}
