-- The AI analysis contract, rewritten.
--
-- Both prompts (apps/api/src/prompts/chart-analysis.ts and candle-analysis.ts)
-- now return a structured read — meta / identity / structure / regime / setup /
-- falsifier / base_rate / summary — instead of the flat reading the columns
-- below were shaped for. The new payload is nested and variable-length
-- (up to three level ZONES, up to two scenarios, each a band rather than a
-- price), so it lands in one jsonb column rather than thirty scalar ones.
--
-- Its TypeScript shape is packages/shared/src/chart-analysis.ts
-- (`AnalysisResult`), and apps/api validates every model response into exactly
-- that shape (apps/api/src/services/analysis-schema.ts) before it is written
-- here. Nothing else may write this column.
--
-- Three fields are promoted out of the payload into their own columns, and
-- only three: they are what the History list renders per row and what a source
-- filter will want to narrow on. Reading them out of jsonb for every row of
-- every page is the one thing the promotion buys, and anything the detail view
-- alone needs stays in the payload where it cannot drift from it.
--
-- WHAT IS DELIBERATELY NOT DROPPED
--
-- asset_class, trend, volatility, volume_reading, sentiment, call_confidence,
-- call_entry, support_levels, resistance_levels and the analysis_patterns
-- table all stay exactly as they are. The new prompts produce none of them —
-- they explicitly forbid a sentiment field and pattern names — so nothing
-- writes them from here on. But every analysis a user has already run is
-- stored in them, and dropping the columns would delete that history to save
-- nothing. Rows written before this migration keep rendering from them; rows
-- written after it render from analysis_result. `analysis_result is not null`
-- is the test for which.

-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------

-- How much of a trade idea the read supports, evaluated in the prompts' own
-- order. 'none' is an abstention and a deliberately common answer: the prompts
-- state that an abstention is a valid, high-quality result and an invented
-- trade is not.
create type setup_format as enum ('confirmed', 'conditional', 'two_scenario', 'none');

-- Structure at the right edge of the chart. Not a synonym for the old
-- `trend` column: that was a bullish/bearish/neutral opinion, this is a
-- description of the swing structure, and 'range' and 'transition' have no
-- equivalent there.
create type structure_state as enum ('uptrend', 'downtrend', 'range', 'transition');

-- What kind of instrument the model read the chart as. Distinct from
-- public.instruments.instrument_type, which is a text column carrying the
-- exchange catalogue's own vocabulary; this is the prompts' fixed list.
create type analysis_instrument_type as enum (
  'equity', 'index', 'futures', 'option', 'crypto', 'fx', 'commodity'
);

-- ---------------------------------------------------------------------------
-- 2. COLUMNS
-- ---------------------------------------------------------------------------

alter table public.analyses
  -- The whole validated model response. Null on every row written before this
  -- migration, and on any row that has not completed yet.
  add column analysis_result jsonb,
  add column setup_format     setup_format,
  add column structure_state  structure_state,
  add column instrument_type  analysis_instrument_type;

comment on column public.analyses.analysis_result is
  'The validated AI analysis payload — see AnalysisResult in packages/shared/src/chart-analysis.ts. Null for rows written before the structured-read prompts, and for rows that have not completed.';

-- The payload is written by the service role only, exactly as every other
-- column on this table is; the existing analyses_select_own policy already
-- covers reading it, so no policy change is needed here.
