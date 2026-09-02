-- Publish public.app_error_logs on the Realtime publication.
--
-- The Logs tab (apps/web/src/app/features/logs/logs-page.ts) read its three
-- sources once on mount and never again, so the failure a user opened it to
-- find could land a second later and not appear until they reloaded — the
-- worst case being the user who opens Logs *because* something is running
-- and watches a page that will never change.
--
-- With this table published, the page subscribes to all three of its sources
-- (daily_briefing_log and watchlist_analysis_runs are already on the
-- publication) and re-reads on any change.
--
-- Same as the other three publication migrations: no policy change needed,
-- Realtime evaluates the existing RLS select policy (app_error_logs_select_own)
-- per subscriber. Rows with a null profile_id — the server-side triage rows
-- this table also holds — match no subscriber and are pushed to nobody.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_error_logs'
  ) then
    alter publication supabase_realtime add table public.app_error_logs;
  end if;
end
$$;
