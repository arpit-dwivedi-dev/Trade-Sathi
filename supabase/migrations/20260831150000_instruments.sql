-- Instrument master data (NSE/BSE equities + indices) backing watchlist
-- symbol search/autocomplete. Populated by the `import:instruments` script
-- (apps/api/scripts or scripts/import-instruments.ts) from a free, public,
-- no-auth instrument dump — never a paid API and never broker credentials.
-- This migration only creates schema; it seeds no rows itself.

create extension if not exists pg_trgm;

create table public.instruments (
  id               uuid primary key default gen_random_uuid(),
  exchange         text not null,
  symbol           text not null,
  name             text not null,
  instrument_type  text not null,
  isin             text,
  -- Provider-specific canonical id (e.g. Upstox's "NSE_EQ|INE...") kept
  -- alongside the neutral (exchange, symbol) identity so a future
  -- market-data provider can be wired up without a schema change.
  instrument_key   text,
  created_at       timestamptz not null default now()
);

create unique index instruments_exchange_symbol_key
  on public.instruments (exchange, symbol);

create unique index instruments_instrument_key_key
  on public.instruments (instrument_key)
  where instrument_key is not null;

-- Trigram indexes power fast partial/case-insensitive ILIKE search on both
-- symbol and name without scanning the whole table.
create index instruments_symbol_trgm_idx
  on public.instruments using gin (symbol gin_trgm_ops);

create index instruments_name_trgm_idx
  on public.instruments using gin (name gin_trgm_ops);

alter table public.instruments enable row level security;

-- Read-only public reference data: any authenticated user can search it,
-- nobody can write to it from the client. The import script uses the
-- service-role key and bypasses RLS entirely.
create policy instruments_select_all on public.instruments
  for select to authenticated
  using (true);

revoke all on public.instruments from anon, authenticated;
grant select on public.instruments to authenticated;

-- Watchlist now points at a canonical instrument. `symbol` is kept as-is so
-- existing rows keep displaying and nothing is lost; it becomes the
-- "unresolved legacy entry" fallback for rows this migration's backfill
-- (or the import script's re-run of it) cannot match to an instrument.
alter table public.watchlist_items
  add column instrument_id uuid references public.instruments(id);

-- Duplicate protection for the new instrument-based path. The pre-existing
-- unique (profile_id, symbol) constraint still guards the legacy path.
create unique index watchlist_items_profile_instrument_key
  on public.watchlist_items (profile_id, instrument_id)
  where instrument_id is not null;

-- Best-effort backfill from free-text symbol to a canonical instrument,
-- preferring NSE over BSE on a tie. Safe to re-run: only touches rows that
-- are still unresolved. Runs again (with real effect) after the import
-- script seeds `instruments`, since no rows exist there yet at migration
-- time.
update public.watchlist_items w
set instrument_id = i.id
from (
  select distinct on (upper(symbol)) id, symbol
  from public.instruments
  order by upper(symbol), (exchange = 'NSE') desc
) i
where w.instrument_id is null
  and upper(w.symbol) = upper(i.symbol);
