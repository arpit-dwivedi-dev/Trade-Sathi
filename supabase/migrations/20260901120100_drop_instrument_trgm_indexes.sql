-- Drop the two trigram indexes on public.instruments.
--
-- They were added for the three-query ILIKE search that
-- apps/api/src/services/instruments.service.ts replaced with an in-memory
-- matcher over the whole catalogue: instrument search no longer touches the
-- database at all, so nothing reads instruments_name_trgm_idx.
--
-- instruments_symbol_trgm_idx has exactly one remaining reader, and it is worth
-- naming rather than pretending otherwise: the legacy-watchlist backfill loop in
-- scripts/import-instruments.ts does `.ilike('symbol', <exact value>)` once per
-- unresolved row. That is a maintenance path over a catalogue of a few thousand
-- rows, run occasionally and against a set that shrinks to empty — a sequential
-- scan there costs milliseconds. Keeping a GIN trigram index continuously
-- maintained on every import to serve it is the wrong side of that trade, which
-- is the whole reason this migration exists.
--
-- Kept as its own migration so restoring them is a one-line revert if instrument
-- search ever moves back into the database.

drop index if exists public.instruments_symbol_trgm_idx;
drop index if exists public.instruments_name_trgm_idx;
