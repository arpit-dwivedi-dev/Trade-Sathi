-- Durable record of a single "Analyze Now" run, and the chart window an
-- analysis was produced from.

-- ---------------------------------------------------------------------------
-- 1. analyses.analysis_lookback_days
-- ---------------------------------------------------------------------------
-- Which window a watchlist analysis was read from. Nullable because a manual
-- screenshot upload has no window of ours — the user chose it in their own
-- charting tool. Needed to answer "have I already analysed this stock over
-- this exact span?", which is otherwise unanswerable from the row.
alter table public.analyses
  add column analysis_lookback_days int
    constraint analyses_analysis_lookback_days_range
    check (analysis_lookback_days is null or analysis_lookback_days between 1 and 365);

-- ---------------------------------------------------------------------------
-- 2. TABLE: watchlist_analysis_runs
-- ---------------------------------------------------------------------------
-- The analyses row for an Analyze Now request only appears once the whole
-- fetch/chart/AI pipeline has succeeded, 20-30s+ later. Until then a client
-- that reloads the page (or opens it on another device) has nothing to find,
-- so an in-flight run looked to the user like it had never been started, and
-- a run that finished while they were away was silently invisible.
--
-- This table is that missing record: a row is written the moment a run is
-- accepted and updated when it settles, so the state of a run survives the
-- browser. It is deliberately separate from analyses rather than an early
-- 'queued' analyses row: analyses columns (image_key, model_id,
-- prompt_version) describe a completed model call and have nothing to hold
-- before one exists.
create table public.watchlist_analysis_runs (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  watchlist_item_id uuid not null references public.watchlist_items(id) on delete cascade,
  instrument_id     uuid not null references public.instruments(id),
  lookback_days     int not null,
  status            analysis_status not null default 'processing',
  -- Set when the run completes; the analysis it produced.
  analysis_id       uuid references public.analyses(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index watchlist_analysis_runs_profile_created_idx
  on public.watchlist_analysis_runs (profile_id, created_at desc);

alter table public.watchlist_analysis_runs enable row level security;

create policy watchlist_analysis_runs_select_own on public.watchlist_analysis_runs
  for select
  using (profile_id = auth.uid());

-- Server-only writes, same reasoning as analyses and daily_briefing_log: the
-- pipeline decides a run's outcome, never a client.
revoke all on public.watchlist_analysis_runs from anon, authenticated;
grant select on public.watchlist_analysis_runs to authenticated;
