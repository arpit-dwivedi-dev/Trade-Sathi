-- ChartAnalyzer — record when an analysis was emailed to its owner.
--
-- Two paths now email an analysis: the scheduled daily briefing digest, and
-- the per-row "Brief Now" action. Both leave an ordinary `analyses` row behind,
-- indistinguishable in History from an Analyze Now run that emailed nothing —
-- so a user could not tell which results had actually reached their inbox, and
-- support could not answer "was it sent?" without reading provider logs.
--
-- On `analyses` rather than on watchlist_analysis_runs, even though Brief Now
-- writes a run row too: the digest has no run row at all, History reads
-- `analyses`, and the fact being recorded is about the analysis, not about the
-- click that produced it. One column answers it for both paths.
--
-- Nullable with no default. NULL means "never emailed", which is the honest
-- state for every row that exists today and for every Analyze Now, live and
-- manual analysis from here on.
alter table public.analyses
  add column emailed_at timestamptz;

comment on column public.analyses.emailed_at is
  'When this analysis was emailed to its owner (daily briefing digest or Brief Now). NULL means never emailed.';

-- No index: History already filters by profile_id and orders by created_at,
-- and this column is only ever read as part of a row that query already
-- returned. Adding one now would be indexing for a query nothing makes.
--
-- No RLS change either. analyses' existing select-own policy covers the whole
-- row, and writes to this column happen only through the service role, which
-- is the same discipline every other server-written column here follows.
