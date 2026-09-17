-- TradeSathi — initial schema
-- Plans, profiles (1:1 with auth.users), monthly usage counters,
-- chart analyses and their structured pattern detections.

-- ---------------------------------------------------------------------------
-- 1. EXTENSIONS
-- ---------------------------------------------------------------------------

-- Required for gen_random_uuid().
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 2. ENUMS
-- ---------------------------------------------------------------------------

create type plan_key        as enum ('free', 'pro_monthly', 'pro_annual');
create type source_type     as enum ('paste', 'upload');
create type asset_class     as enum ('crypto', 'stock', 'forex', 'commodity', 'index');
create type timeframe       as enum ('m1', 'm5', 'm15', 'h1', 'h4', 'd1', 'w1');
create type trend_reading   as enum ('bullish', 'bearish', 'neutral');
create type level_reading   as enum ('low', 'medium', 'high');
create type call_direction  as enum ('long', 'short', 'hold');
create type analysis_status as enum ('queued', 'processing', 'complete', 'failed');

-- ---------------------------------------------------------------------------
-- 3. TABLE: plans
-- ---------------------------------------------------------------------------

-- Stores the available subscription plans.
create table public.plans (
  id                  uuid primary key default gen_random_uuid(),
  key                 plan_key not null unique,
  name                text not null,
  analyses_per_month  int not null,
  price_inr_paise     int not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

insert into public.plans (key, name, analyses_per_month, price_inr_paise) values
  ('free',        'Free',       3,     0),
  ('pro_monthly', 'Pro Monthly', 100, 24900);

alter table public.plans enable row level security;

-- Plan data is only ever written by migrations or a future admin tool, never by
-- the API using client roles — hence read-only for anon/authenticated, and no
-- INSERT/UPDATE/DELETE policies at all.
create policy plans_select_active on public.plans
  for select
  to anon, authenticated
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- 4. TABLE: profiles
-- ---------------------------------------------------------------------------

-- Stores the application profile corresponding one-to-one with auth.users.
create table public.profiles (
  -- No default: always set explicitly to auth.users.id by handle_new_user().
  -- The FK with ON DELETE CASCADE enforces the 1:1 relationship at the database
  -- level — deleting an auth.users row deletes its profile row too.
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null unique,
  full_name       text,
  email_verified  boolean not null default false,
  locale          text not null default 'en',
  timezone        text not null default 'Asia/Kolkata',
  plan_id         uuid not null references public.plans(id) on delete restrict,
  signup_source   text,
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz
);

-- TRIGGER A — create the matching profile row on signup.
-- SECURITY DEFINER: needs elevated privilege to write into public.profiles on
-- behalf of a caller that has no direct grants on it.
-- SET search_path = '' (empty) hardens the function against search_path
-- hijacking, so every reference below must be fully qualified.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_free_plan_id uuid;
begin
  if new.email is null then
    raise exception 'Cannot create profile: auth.users.email is null';
  end if;

  select p.id into v_free_plan_id
  from public.plans p
  where p.key = 'free';

  insert into public.profiles (id, email, email_verified, plan_id)
  values (
    new.id,
    new.email,
    (new.email_confirmed_at is not null),
    v_free_plan_id
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- TRIGGER B — keep profiles in sync after email verification or change.
-- Without this, a user who verifies their email after signup would remain
-- permanently unverified in profiles.
-- The trigger is column-scoped (AFTER UPDATE OF email, email_confirmed_at), so
-- it only fires when an UPDATE statement's SET clause touches one of those two
-- columns — not on every auth.users update (last_sign_in_at, metadata, etc.).
-- SECURITY DEFINER for the same reason as Trigger A; search_path = '' (empty),
-- so public.profiles is fully qualified below.
create function public.handle_user_email_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Announce a trusted profile sync for exactly the one UPDATE below. The third
  -- argument (true) scopes the setting to the current transaction only: it
  -- clears automatically at transaction end, commit or rollback, so it can
  -- never leak into an unrelated later transaction.
  perform set_config('tradesathi.trusted_profile_sync', 'on', true);

  update public.profiles
  set email = new.email,
      email_verified = (new.email_confirmed_at is not null)
  where id = new.id;

  perform set_config('tradesathi.trusted_profile_sync', 'off', true);

  return new;
end;
$$;

create trigger on_auth_user_email_updated
  after update of email, email_confirmed_at on auth.users
  for each row
  execute function public.handle_user_email_update();

-- TRIGGER C — block direct client modification of protected profile columns.
--
-- SECURITY INVOKER (the PostgreSQL default — deliberately NOT declared SECURITY
-- DEFINER). This is essential, not stylistic: the check below reads current_user
-- to identify who actually issued the UPDATE. Under SECURITY DEFINER,
-- current_user would be reassigned to the function's own owner for the duration
-- of the call, masking the real caller's role and making the role check
-- meaningless. Triggers A and B are SECURITY DEFINER because they need elevated
-- privilege to write into public.profiles on behalf of a caller who may not have
-- direct grants. Trigger C's job is the opposite — it must see the true caller's
-- identity to make an authorization decision, so it must not elevate privilege.
--
-- The three parts of the condition:
--   * current_setting(..., true) — the second argument (true) means
--     "missing_ok": if the flag was never set in this transaction (the normal
--     case for any update not originating from Trigger B) this returns NULL
--     instead of raising an "unrecognized configuration parameter" error, hence
--     the coalesce to 'off'.
--   * The flag is explicitly set to 'on' by Trigger B immediately before its own
--     UPDATE of profiles, and back to 'off' immediately after. It is an
--     explicit, narrowly-scoped statement of trust for exactly that one UPDATE
--     statement — not an incidental property like call nesting depth.
--   * current_user <> 'service_role' separately allows a future direct backend
--     call using the service role to change these columns without needing the
--     trusted-context flag at all.
create function public.protect_profile_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'service_role'
     and coalesce(current_setting('tradesathi.trusted_profile_sync', true), 'off') <> 'on'
     and (
       new.plan_id        is distinct from old.plan_id or
       new.email          is distinct from old.email or
       new.email_verified is distinct from old.email_verified or
       new.signup_source  is distinct from old.signup_source
     )
  then
    raise exception 'Direct modification of protected profile columns is not allowed';
  end if;

  return new;
end;
$$;

create trigger protect_profile_columns
  before update on public.profiles
  for each row
  execute function public.protect_profile_columns();

alter table public.profiles enable row level security;

-- Trigger C is what actually protects the sensitive columns; these policies only
-- govern which rows a user may touch at all. Profile rows are created only by
-- Trigger A, so there is no client INSERT or DELETE policy.
create policy profiles_select_own on public.profiles
  for select
  using (id = auth.uid());

create policy profiles_update_own on public.profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. TABLE: usage_counters
-- ---------------------------------------------------------------------------

-- Stores per-user monthly analysis usage counters.
create table public.usage_counters (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  period         text not null, -- YYYY-MM
  analyses_used  int not null default 0,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create unique index usage_counters_profile_id_period_key
  on public.usage_counters (profile_id, period);

alter table public.usage_counters enable row level security;

-- Read-only for clients. Usage writes happen only server-side via the service
-- role, because increments must be atomic.
create policy usage_counters_select_own on public.usage_counters
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. TABLE: analyses
-- ---------------------------------------------------------------------------

-- Stores chart-analysis inputs, model outputs, metadata and outcome-calibration fields.
create table public.analyses (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  source_type       source_type not null,
  image_key         text not null,  -- Supabase Storage object path
  image_hash        text,           -- SHA-256 of compressed bytes, for future dedupe/caching
  width_px          int,
  height_px         int,
  symbol_raw        text,           -- exactly what the model read off the chart
  symbol            text,           -- normalized/matched symbol; null until phase-2 matching exists
  asset_class       asset_class,
  timeframe         timeframe,
  trend             trend_reading,
  volatility        level_reading,
  volume_reading    level_reading,
  sentiment         trend_reading,
  support_levels    numeric[],
  resistance_levels numeric[],
  call_direction    call_direction,
  -- Direct output field of the AI analysis call itself: it cannot be backfilled
  -- later without re-running historical analyses through the model. Never remove.
  call_confidence   numeric check (call_confidence is null or (call_confidence >= 0 and call_confidence <= 1)),
  call_entry        numeric,
  call_invalidation numeric,
  call_target       numeric,
  -- Direct AI output field, not backfillable later. Never remove.
  horizon_candles   int check (horizon_candles is null or horizon_candles > 0),
  summary           text,
  model_id          text not null,
  prompt_version    text not null,
  input_tokens      int,
  output_tokens     int,
  cost_usd          numeric,
  latency_ms        int,
  status            analysis_status not null default 'queued',
  error_code        text,
  error_message     text,
  created_at        timestamptz not null default now()
);

create index analyses_profile_id_created_at_idx on public.analyses (profile_id, created_at desc);
create index analyses_image_hash_created_at_idx on public.analyses (image_hash, created_at);
create index analyses_status_created_at_idx     on public.analyses (status, created_at);

alter table public.analyses enable row level security;

-- Clients get SELECT only, and this is an intentional architectural decision,
-- not an oversight: all writes to this table happen server-side via the service
-- role key, which enforces quota checks, cost tracking and status transitions
-- that must not be bypassable by a direct client call.
create policy analyses_select_own on public.analyses
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 7. TABLE: analysis_patterns
-- ---------------------------------------------------------------------------

-- Stores structured pattern detections associated with an analysis.
create table public.analysis_patterns (
  id            uuid primary key default gen_random_uuid(),
  analysis_id   uuid not null references public.analyses(id) on delete cascade,
  pattern_key   text not null,
  confidence    numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  pattern_note  text,
  created_at    timestamptz not null default now()
);

create index analysis_patterns_analysis_id_idx on public.analysis_patterns (analysis_id);
create index analysis_patterns_pattern_key_idx on public.analysis_patterns (pattern_key);

alter table public.analysis_patterns enable row level security;

-- Readable only when the parent analysis belongs to the current authenticated
-- user. Writes happen server-side via the service role, as for analyses.
create policy analysis_patterns_select_own on public.analysis_patterns
  for select
  using (
    exists (
      select 1 from public.analyses a
      where a.id = analysis_patterns.analysis_id
        and a.profile_id = auth.uid()
    )
  );
