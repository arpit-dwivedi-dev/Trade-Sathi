-- TradeSathi — the fundamentals AI analysis entitlement.
--
-- A fully separate pool from the manual chart-analysis quota/credit and from
-- the Daily Briefing subscription: pricing and plans for this feature are not
-- decided yet, so this is a flat, plan-independent monthly cap rather than a
-- profiles.plan_id / subscriptions join. It is modeled on the Daily Briefing
-- entitlement (20260831160400_daily_briefing_entitlement_functions.sql),
-- which is likewise a separate pool with no credit fallback — "quota
-- exhausted" means denied, full stop. Raise or replace v_limit below, or wire
-- it to a real plan, once pricing exists.

-- ---------------------------------------------------------------------------
-- 1. TABLE: fundamentals_usage_counters
-- ---------------------------------------------------------------------------

create table public.fundamentals_usage_counters (
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  period         text not null, -- YYYY-MM, UTC
  analyses_used  int not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (profile_id, period)
);

alter table public.fundamentals_usage_counters enable row level security;

-- Read-only for clients. Usage writes happen only server-side via the service
-- role, because increments must be atomic.
create policy fundamentals_usage_counters_select_own on public.fundamentals_usage_counters
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. FUNCTION: check_and_consume_fundamentals_entitlement
-- ---------------------------------------------------------------------------

-- Returns true if the caller's fundamentals analysis is within quota (and
-- consumes one unit), false if this period's allowance is already used up.
--
-- Same row-lock technique as check_and_increment_usage: SELECT ... FOR UPDATE
-- takes an exclusive lock on the (profile_id, period) counter row, so
-- concurrent calls for the same user serialize instead of both reading a
-- stale count and overshooting the allowance. See that function's comments
-- for the full reasoning; not repeated here.
--
-- SECURITY DEFINER because callers hold no direct grants on
-- fundamentals_usage_counters. SET search_path = '' hardens against
-- hijacking, so every reference below is fully qualified.
create function public.check_and_consume_fundamentals_entitlement(p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Placeholder flat cap: pricing/plans for fundamentals analysis are not
  -- decided yet, so every profile shares one number rather than a plans join.
  -- Revisit once that decision is made.
  v_limit  int := 10;
  v_period text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_used   int;
begin
  insert into public.fundamentals_usage_counters (profile_id, period)
  values (p_profile_id, v_period)
  on conflict (profile_id, period) do nothing;

  select uc.analyses_used into v_used
  from public.fundamentals_usage_counters uc
  where uc.profile_id = p_profile_id
    and uc.period = v_period
  for update;

  if v_used is null then
    raise exception 'Fundamentals usage counter row missing for profile % period %', p_profile_id, v_period;
  end if;

  if v_used >= v_limit then
    return false;
  end if;

  update public.fundamentals_usage_counters
  set analyses_used = analyses_used + 1,
      updated_at = now()
  where profile_id = p_profile_id
    and period = v_period;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. FUNCTION: decrement_fundamentals_usage
-- ---------------------------------------------------------------------------

-- The compensating decrement for a consumed-but-unusable unit — called when
-- the fundamentals fetch or the AI call fails after the entitlement was
-- already consumed. Same shape and accepted trade-offs as decrement_usage: a
-- single guarded atomic UPDATE, the caller supplies the exact period it
-- consumed against, and a failure of this call itself is an accepted MVP loss.
create function public.decrement_fundamentals_usage(p_profile_id uuid, p_period text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.fundamentals_usage_counters
  set analyses_used = analyses_used - 1,
      updated_at = now()
  where profile_id = p_profile_id
    and period = p_period
    and analyses_used > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only: this is the quota gate for a paid resource, so it must be
-- callable exclusively by the API's service role. anon and authenticated are
-- revoked explicitly, not just via PUBLIC — Supabase auto-grants EXECUTE on
-- new public-schema functions directly to both roles, so those grants are
-- held in their own right and would survive a revoke from PUBLIC alone.
revoke execute on function
  public.check_and_consume_fundamentals_entitlement(uuid),
  public.decrement_fundamentals_usage(uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.check_and_consume_fundamentals_entitlement(uuid),
  public.decrement_fundamentals_usage(uuid, text)
  to service_role;
