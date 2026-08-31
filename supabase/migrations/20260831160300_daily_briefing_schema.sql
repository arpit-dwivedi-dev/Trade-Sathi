-- Daily Briefing: usage counters, idempotency log, and analyses provenance.

-- ---------------------------------------------------------------------------
-- 1. TABLE: daily_briefing_usage_counters
-- ---------------------------------------------------------------------------

-- The automation-quota mirror of public.usage_counters. A separate table,
-- not a shared one with a "kind" column, so a bug in one entitlement path can
-- never bleed into the other's counter — the schema itself enforces that
-- manual and automated usage never share a row.
create table public.daily_briefing_usage_counters (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  period         text not null, -- YYYY-MM, UTC — same convention as usage_counters
  analyses_used  int not null default 0,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create unique index daily_briefing_usage_counters_profile_id_period_key
  on public.daily_briefing_usage_counters (profile_id, period);

alter table public.daily_briefing_usage_counters enable row level security;

create policy daily_briefing_usage_counters_select_own on public.daily_briefing_usage_counters
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. TABLE: daily_briefing_log
-- ---------------------------------------------------------------------------

-- One row per user per calendar briefing date. This is the idempotency guard
-- the scheduler relies on: the job inserts a 'processing' row for
-- (profile_id, briefing_date) before doing any work, and a unique-violation
-- on that insert means today's briefing already ran (or is running) for this
-- user, so the job stops immediately without a second email.
create type daily_briefing_status as enum (
  'processing',
  'sent',
  'sent_partial',
  'skipped_no_symbols',
  'skipped_no_entitlement',
  'skipped_quota_exhausted',
  'failed'
);

create table public.daily_briefing_log (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  briefing_date  date not null,
  status         daily_briefing_status not null default 'processing',
  symbols_sent   int not null default 0,
  symbols_failed int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint daily_briefing_log_profile_id_briefing_date_key unique (profile_id, briefing_date)
);

create index daily_briefing_log_briefing_date_idx on public.daily_briefing_log (briefing_date);

alter table public.daily_briefing_log enable row level security;

create policy daily_briefing_log_select_own on public.daily_briefing_log
  for select
  using (profile_id = auth.uid());

-- Server-only writes, same reasoning as usage_counters/analyses: the job
-- itself decides idempotency and outcome, never a client.
revoke all on public.daily_briefing_usage_counters, public.daily_briefing_log
  from anon, authenticated;
grant select on public.daily_briefing_usage_counters, public.daily_briefing_log
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. TABLE: analyses — provenance columns
-- ---------------------------------------------------------------------------

create type analysis_source as enum ('manual', 'watchlist_daily');

alter table public.analyses
  add column source analysis_source not null default 'manual',
  -- Only set for source = 'watchlist_daily'. A manual screenshot upload has
  -- no resolved canonical instrument, so this stays null there.
  add column instrument_id uuid references public.instruments(id),
  -- The date of the last (most recent completed) candle used to generate the
  -- chart image, so the email/UI can show "as of <date>" rather than
  -- implying this is live/current-moment data.
  add column market_data_date date;

create index analyses_instrument_id_idx on public.analyses (instrument_id) where instrument_id is not null;
create index analyses_source_created_at_idx on public.analyses (source, created_at);
