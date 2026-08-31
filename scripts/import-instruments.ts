// Populates public.instruments from Upstox's free, public, no-auth
// instrument master dump (https://upstox.com/developer/api-documentation/
// instruments/) — a plain static JSON.gz file, not a broker/trading API:
// no API key, no OAuth, no account. Filtered down to NSE/BSE equities and
// indices, which is all the watchlist's search needs.
//
// Safe to re-run: upserts on (exchange, symbol), so it both seeds and
// refreshes the dataset. Also re-runs the legacy-symbol backfill from the
// instruments migration, since that migration ran before any instrument
// rows existed.
//
//   pnpm tsx scripts/import-instruments.ts
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const envLines = readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n');
const getEnv = (key: string) =>
  process.env[key] ?? envLines.find((l) => l.startsWith(key + '='))?.slice(key.length + 1).trim();

const SUPABASE_URL = getEnv('SUPABASE_URL');
const SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const DUMP_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

interface UpstoxInstrument {
  segment: string;
  exchange: string;
  name: string;
  isin?: string;
  instrument_type?: string;
  instrument_key: string;
  trading_symbol: string;
}

interface InstrumentRow {
  exchange: string;
  symbol: string;
  name: string;
  instrument_type: string;
  isin: string | null;
  instrument_key: string;
}

// Only main-board equities (segment's many *series* codes like BE/BZ/N1 are
// intentionally excluded to keep search results to the primary listing) and
// indices — everything else (F&O, currency, commodity derivatives) is out of
// scope for a symbol watchlist.
function toRow(d: UpstoxInstrument): InstrumentRow | null {
  const isEquity =
    (d.segment === 'NSE_EQ' || d.segment === 'BSE_EQ') && d.instrument_type === 'EQ';
  const isIndex = d.segment === 'NSE_INDEX' || d.segment === 'BSE_INDEX';
  if (!isEquity && !isIndex) return null;

  return {
    exchange: d.exchange,
    symbol: d.trading_symbol,
    name: d.name,
    instrument_type: isIndex ? 'INDEX' : 'EQUITY',
    isin: d.isin ?? null,
    instrument_key: d.instrument_key,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const admin = createClient(SUPABASE_URL as string, SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Fetching ${DUMP_URL} ...`);
  const res = await fetch(DUMP_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const all = JSON.parse(gunzipSync(gz).toString('utf8')) as UpstoxInstrument[];

  const rows: InstrumentRow[] = [];
  const seen = new Set<string>();
  for (const d of all) {
    const row = toRow(d);
    if (!row) continue;
    // The dump can carry the same (exchange, symbol) more than once across
    // segments in rare cases; first one wins, matching the table's unique
    // (exchange, symbol) index.
    const key = `${row.exchange}|${row.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  console.log(`Filtered to ${rows.length} equities/indices out of ${all.length} instruments.`);

  let upserted = 0;
  for (const batch of chunk(rows, 1000)) {
    const { error } = await admin
      .from('instruments')
      .upsert(batch, { onConflict: 'exchange,symbol' });
    if (error) throw new Error(`Upsert failed: ${error.message}`);
    upserted += batch.length;
    process.stdout.write(`\rUpserted ${upserted}/${rows.length}`);
  }
  console.log();

  console.log('Backfilling legacy watchlist symbols to canonical instruments...');
  const { data: unresolved, error: unresolvedError } = await admin
    .from('watchlist_items')
    .select('id, symbol')
    .is('instrument_id', null);
  if (unresolvedError) throw new Error(`Fetching unresolved rows failed: ${unresolvedError.message}`);

  let backfilled = 0;
  for (const item of unresolved ?? []) {
    const { data: matches, error: matchError } = await admin
      .from('instruments')
      .select('id, exchange')
      .ilike('symbol', item.symbol)
      .order('exchange', { ascending: true }); // 'BSE' < 'NSE' alphabetically; NSE preferred below
    if (matchError) throw new Error(`Match lookup failed: ${matchError.message}`);
    const match = matches?.find((m) => m.exchange === 'NSE') ?? matches?.[0];
    if (!match) continue;

    const { error: updateError } = await admin
      .from('watchlist_items')
      .update({ instrument_id: match.id })
      .eq('id', item.id);
    if (updateError) throw new Error(`Backfill update failed: ${updateError.message}`);
    backfilled += 1;
  }
  console.log(`Backfilled ${backfilled}/${unresolved?.length ?? 0} legacy watchlist rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
