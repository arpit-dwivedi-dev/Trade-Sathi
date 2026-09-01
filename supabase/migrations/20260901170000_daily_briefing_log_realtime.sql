-- Publish public.daily_briefing_log on the Realtime publication.
--
-- The Watchlist page blurs a row while the SCHEDULED job is processing that
-- item (see scheduledBusyItemIds in apps/web/src/app/features/watchlist/
-- watchlist.ts), driven by a postgres_changes subscription on this table
-- rather than a poll: a scheduled run is typically seconds long, so a fixed
-- poll interval would either miss it between ticks or add constant
-- background traffic for something that changes rarely. Without this table
-- on the publication the subscription is silently a no-op — the client
-- receives no events at all, not an error — which is exactly what happened
-- before this migration.
--
-- Mirrors 20260901120000_analyses_realtime.sql: no policy change needed,
-- Realtime evaluates the table's existing RLS select policy
-- (daily_briefing_log_select_own) per subscriber, so a client is only ever
-- pushed rows it could already have read.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_briefing_log'
  ) then
    alter publication supabase_realtime add table public.daily_briefing_log;
  end if;
end
$$;
