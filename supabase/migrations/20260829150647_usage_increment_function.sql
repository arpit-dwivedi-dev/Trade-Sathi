-- ChartAnalyzer — atomic monthly usage quota check-and-increment.
--
-- Replaces any read-then-write quota check in application code, which is
-- inherently racy: two concurrent requests could both read analyses_used = 2
-- against a limit of 3 and both proceed, taking the user to 4.

-- ---------------------------------------------------------------------------
-- FUNCTION: check_and_increment_usage
-- ---------------------------------------------------------------------------

-- Returns true if the caller's analysis is within quota (and consumes one
-- unit), false if the monthly quota is already exhausted (and changes nothing).
--
-- The row lock is the whole point of this function. SELECT ... FOR UPDATE takes
-- an exclusive lock on the (profile_id, period) counter row and holds it until
-- the calling transaction commits or rolls back. A second concurrent call for
-- the same user blocks at that SELECT until the first transaction finishes, and
-- then — under READ COMMITTED, FOR UPDATE re-reads the row after the lock is
-- granted — sees the first call's incremented value rather than the stale one it
-- would have read a moment earlier. Checking the limit and incrementing the
-- counter therefore happen as one indivisible step per user, so the quota can
-- never be overshot no matter how many requests arrive at once.
--
-- The period bucket is always computed in UTC. profiles.timezone is a display
-- preference only and is deliberately not consulted here: bucketing by a
-- per-user timezone would make quota boundaries shift with a profile edit.
--
-- SECURITY DEFINER because callers hold no direct grants on the tables below.
-- SET search_path = '' (empty) hardens it against search_path hijacking, so
-- every table reference is fully qualified.
create function public.check_and_increment_usage(p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_limit  int;
  v_used   int;
begin
  select pl.analyses_per_month into v_limit
  from public.profiles pr
  join public.plans pl on pl.id = pr.plan_id
  where pr.id = p_profile_id;

  if v_limit is null then
    raise exception 'No plan found for profile %', p_profile_id;
  end if;

  -- Make sure this period's counter row exists before locking it. DO NOTHING
  -- rather than DO UPDATE: a row already being inserted by a concurrent
  -- transaction is exactly the outcome we want, and the FOR UPDATE below then
  -- serializes against it.
  insert into public.usage_counters (profile_id, period)
  values (p_profile_id, v_period)
  on conflict (profile_id, period) do nothing;

  select uc.analyses_used into v_used
  from public.usage_counters uc
  where uc.profile_id = p_profile_id
    and uc.period = v_period
  for update;

  -- The insert above guarantees the row exists; a miss here would mean the
  -- counter was deleted mid-call, and must not be read as spare quota.
  if v_used is null then
    raise exception 'Usage counter row missing for profile % period %', p_profile_id, v_period;
  end if;

  if v_used >= v_limit then
    return false;
  end if;

  update public.usage_counters
  set analyses_used = analyses_used + 1,
      updated_at = now()
  where profile_id = p_profile_id
    and period = v_period;

  return true;
end;
$$;

-- Server-side only: this function is the quota gate, so it must be callable
-- exclusively by the API's service role.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC. Supabase
-- auto-grants EXECUTE on new public-schema functions directly to both roles, so
-- those grants are held in their own right and would survive a revoke from
-- PUBLIC alone.
revoke execute on function public.check_and_increment_usage(uuid) from public, anon, authenticated;
grant execute on function public.check_and_increment_usage(uuid) to service_role;
