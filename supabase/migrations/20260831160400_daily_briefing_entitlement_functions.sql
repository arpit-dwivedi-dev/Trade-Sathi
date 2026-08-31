-- ChartAnalyzer — atomic Daily Briefing entitlement consumption.
--
-- The automation-quota mirror of check_and_increment_usage / decrement_usage,
-- but entitlement here is NOT profiles.plan_id (that column drives the manual
-- flow only). A user's Daily Briefing access is instead a live row in
-- public.subscriptions whose plan is 'daily_briefing_monthly' — the two
-- products are billed through the same subscriptions table but never share a
-- single "current plan" slot, which is what lets a user hold both
-- independently.
--
-- There is deliberately no credit fallback here (unlike
-- check_and_consume_entitlement for manual analyses): quota exhausted means
-- 'denied', full stop. No auto-charge, no borrowing from manual credits.

-- ---------------------------------------------------------------------------
-- FUNCTION: check_and_consume_daily_briefing_entitlement
-- ---------------------------------------------------------------------------

-- Returns exactly one of:
--   'consumed'          — an automation-quota unit was consumed.
--   'no_subscription'   — no live Daily Briefing subscription for this profile.
--   'quota_exhausted'   — subscription is live, but this period's allowance is used up.
--
-- Mirrors check_and_increment_usage's row-lock technique: the counter row is
-- locked with SELECT ... FOR UPDATE before being compared and incremented, so
-- concurrent calls for the same profile serialize instead of both reading a
-- stale count and overshooting the allowance.
--
-- SECURITY DEFINER: callers hold no direct grants on daily_briefing_usage_counters
-- or subscriptions writes. SET search_path = '' hardens against hijacking, so
-- every reference below is fully qualified.
create function public.check_and_consume_daily_briefing_entitlement(p_profile_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Schema-qualified: with search_path = '' set on this function, PL/pgSQL
  -- resolves a DECLARE block's variable types against that empty path (unlike
  -- a CREATE FUNCTION parameter list, which the outer parser resolves against
  -- the ambient session search_path before this function-level setting ever
  -- applies) — an unqualified enum name here fails with "type does not exist".
  v_plan_key public.plan_key;
  v_limit    int;
  v_period   text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_used     int;
begin
  -- A "live" subscription mirrors billing.service.ts's LIVE_SUBSCRIPTION_STATUSES.
  select pl.key into v_plan_key
  from public.subscriptions s
  join public.plans pl on pl.id = s.plan_id
  where s.profile_id = p_profile_id
    and pl.key = 'daily_briefing_monthly'
    and s.status in ('authenticated', 'active', 'pending', 'halted', 'paused')
  order by s.created_at desc
  limit 1;

  if v_plan_key is null then
    return 'no_subscription';
  end if;

  select monthly_auto_analyses into v_limit
  from public.daily_briefing_entitlements
  where plan_key = v_plan_key;

  if v_limit is null then
    raise exception 'No daily_briefing_entitlements row for plan %', v_plan_key;
  end if;

  insert into public.daily_briefing_usage_counters (profile_id, period)
  values (p_profile_id, v_period)
  on conflict (profile_id, period) do nothing;

  select uc.analyses_used into v_used
  from public.daily_briefing_usage_counters uc
  where uc.profile_id = p_profile_id
    and uc.period = v_period
  for update;

  if v_used is null then
    raise exception 'Daily briefing usage counter row missing for profile % period %', p_profile_id, v_period;
  end if;

  if v_used >= v_limit then
    return 'quota_exhausted';
  end if;

  update public.daily_briefing_usage_counters
  set analyses_used = analyses_used + 1,
      updated_at = now()
  where profile_id = p_profile_id
    and period = v_period;

  return 'consumed';
end;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION: decrement_daily_briefing_usage
-- ---------------------------------------------------------------------------

-- The compensating decrement for a consumed-but-unusable automation-quota
-- unit — called when market-data fetch, chart rendering, or the AI call fails
-- after the entitlement was already consumed, so quota is never spent on a
-- failed attempt. Same shape and the same accepted trade-offs as
-- decrement_usage (see that function's comments): a single guarded atomic
-- UPDATE, the caller supplies the exact period it consumed against rather
-- than letting this recompute "now", and a failure of this call itself is an
-- accepted MVP loss rather than a corruption risk.
create function public.decrement_daily_briefing_usage(p_profile_id uuid, p_period text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.daily_briefing_usage_counters
  set analyses_used = analyses_used - 1,
      updated_at = now()
  where profile_id = p_profile_id
    and period = p_period
    and analyses_used > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------

revoke execute on function
  public.check_and_consume_daily_briefing_entitlement(uuid),
  public.decrement_daily_briefing_usage(uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.check_and_consume_daily_briefing_entitlement(uuid),
  public.decrement_daily_briefing_usage(uuid, text)
  to service_role;
