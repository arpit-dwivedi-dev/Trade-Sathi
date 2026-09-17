-- TradeSathi — compensating decrement for a consumed-but-unusable quota unit.
--
-- check_and_increment_usage consumes a unit up front, before the image upload
-- and the analyses insert. If either of those fails, the API hands the unit back
-- by calling this function.
--
-- This exists as a database function rather than an API-side UPDATE because
-- PostgREST cannot express a column-referencing assignment
-- (analyses_used = analyses_used - 1) — an API-side implementation would have to
-- read then write, reintroducing exactly the race that check_and_increment_usage
-- was written to eliminate. Here it is one statement: the row's own current
-- value is decremented under the UPDATE's row lock, so concurrent compensations
-- for the same user serialize instead of clobbering each other.
--
-- The `analyses_used > 0` guard makes the statement safe to lose rather than
-- corrupt: it can never drive the counter negative, and a call naming a period
-- with no row (or a zeroed one) simply affects zero rows instead of erroring.
--
-- p_period is supplied by the caller, not recomputed from now() here. The API
-- captures the period string once before calling check_and_increment_usage and
-- reuses it verbatim, so a request straddling a UTC month boundary compensates
-- against the period it most likely incremented rather than whichever month the
-- clock has since rolled into.
--
-- SECURITY DEFINER because callers hold no direct grants on usage_counters.
-- SET search_path = '' (empty) hardens it against search_path hijacking, so
-- every table reference is fully qualified.
create function public.decrement_usage(p_profile_id uuid, p_period text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.usage_counters
  set analyses_used = analyses_used - 1,
      updated_at = now()
  where profile_id = p_profile_id
    and period = p_period
    and analyses_used > 0;
end;
$$;

-- Server-side only, for the same reason as check_and_increment_usage: this
-- function hands quota back, so a client able to call it could mint itself
-- unlimited analyses.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC. Supabase
-- auto-grants EXECUTE on new public-schema functions directly to both roles, so
-- those grants are held in their own right and would survive a revoke from
-- PUBLIC alone.
revoke execute on function public.decrement_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.decrement_usage(uuid, text) to service_role;
