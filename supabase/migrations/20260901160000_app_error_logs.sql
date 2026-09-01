-- App-level error log, scoped per user. The "Logs" tab reads three sources —
-- daily_briefing_log and watchlist_analysis_runs already exist and are
-- already RLS-readable; this is the one category that had no persistence at
-- all: apps/api's logger only ever wrote to console/stdout, so a background
-- pipeline failure (Analyze Now, Brief Now, a scheduled briefing) was
-- invisible to the user who hit it unless they went looking at server logs.

create table public.app_error_logs (
  id          uuid primary key default gen_random_uuid(),
  -- Nullable: some failures (a webhook signature check, a cron tick with no
  -- resolvable user) have no profile to attach to. Those rows exist for
  -- server-side triage only and are excluded from every user's own read by
  -- the RLS policy below, never surfaced in the UI.
  profile_id  uuid references public.profiles(id) on delete cascade,
  -- Free-text category rather than an enum: unlike daily_briefing_status
  -- (a fixed state machine the scheduler itself branches on), this is purely
  -- descriptive and new categories should not require a migration.
  category    text not null,
  message     text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index app_error_logs_profile_id_created_at_idx
  on public.app_error_logs (profile_id, created_at desc);

alter table public.app_error_logs enable row level security;

create policy app_error_logs_select_own on public.app_error_logs
  for select
  using (profile_id = auth.uid());

-- Server-only writes, same convention as daily_briefing_log/analyses: the API
-- decides what gets logged, never a client.
revoke all on public.app_error_logs from anon, authenticated;
grant select on public.app_error_logs to authenticated;
