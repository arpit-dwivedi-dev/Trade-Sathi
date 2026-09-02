-- Publish public.watchlist_analysis_runs on the Realtime publication.
--
-- "Analyze Now" was the last place in the app still waiting on a fixed poll:
-- the Watchlist page re-read the run row every 3 seconds for up to two
-- minutes (pollRun in apps/web/src/app/features/watchlist/watchlist.ts), so a
-- run that settled just after a tick sat finished in the database for up to
-- three seconds before the user was told, and a page with several runs in
-- flight spent a query per run per tick on a row that changes exactly twice.
--
-- With this table on the publication the client subscribes to the run row
-- instead and keeps only a slow safety-net timer, the same shape the upload
-- and live paths already use (see apps/web/src/app/core/analysis-watch.ts).
--
-- Mirrors 20260901120000_analyses_realtime.sql and
-- 20260901170000_daily_briefing_log_realtime.sql: no policy change needed,
-- Realtime evaluates the table's existing RLS select policy
-- (watchlist_analysis_runs_select_own) per subscriber, so a client is only
-- ever pushed rows it could already have read.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'watchlist_analysis_runs'
  ) then
    alter publication supabase_realtime add table public.watchlist_analysis_runs;
  end if;
end
$$;
