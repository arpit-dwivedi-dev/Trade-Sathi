-- Publish public.analyses on the Realtime publication.
--
-- The web app used to learn that an analysis had finished by re-selecting the
-- row every two seconds until it changed. It now subscribes to the row instead
-- (see apps/web/src/app/core/analysis-watch.ts) and keeps a slow timer purely
-- as a fallback, so the result reaches the UI when it is written rather than up
-- to two seconds later.
--
-- No policy change is needed or wanted: Realtime evaluates the table's existing
-- RLS select policies per subscriber, so a client is only ever pushed rows it
-- could already have read. Default replica identity is sufficient — the app
-- subscribes to INSERT and UPDATE, both of which carry the new row.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'analyses'
  ) then
    alter publication supabase_realtime add table public.analyses;
  end if;
end
$$;
