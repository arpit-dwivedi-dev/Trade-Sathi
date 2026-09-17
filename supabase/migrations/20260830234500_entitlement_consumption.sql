-- TradeSathi — combined quota + credit entitlement consumption.
--
-- Quota and one-off credits are two independent entitlements. Every analysis
-- must draw from exactly one of them, quota first, and the decision must be as
-- atomic as the quota check already was. These two functions are the single
-- place that decision is made.

-- ---------------------------------------------------------------------------
-- FUNCTION: check_and_consume_entitlement
-- ---------------------------------------------------------------------------

-- Returns exactly one of:
--   'quota'  — a monthly quota unit was consumed; credits untouched.
--   'credit' — quota was exhausted, one credit was consumed and ledgered.
--   'denied' — quota exhausted and no credits left; nothing was changed.
--
-- SECURITY INVOKER, deliberately — NOT SECURITY DEFINER. This function updates
-- profiles.credit_balance, which Trigger C (protect_profile_columns) guards by
-- checking current_user = 'service_role'. Under SECURITY DEFINER, current_user
-- inside the function body becomes the function's owner rather than the real
-- caller, so Trigger C would see a non-service_role current_user and
-- incorrectly block the update — the same class of bug already fixed once for
-- apply_subscription_webhook. The real caller here is always the backend using
-- the service role key, which already holds sufficient table privileges, so
-- DEFINER's elevation buys nothing and only breaks the guard.
--
-- SET search_path = '' (empty) hardens it against search_path hijacking, so
-- every reference below is fully qualified.
create function public.check_and_consume_entitlement(p_profile_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new_balance int;
begin
  -- Quota is always tried first, by reusing the existing, already-tested
  -- atomic check-and-increment as-is. Its row-lock semantics are the reason
  -- this logic is not duplicated here.
  if public.check_and_increment_usage(p_profile_id) then
    return 'quota';
  end if;

  -- Quota exhausted. Attempt to consume one credit. The `credit_balance > 0`
  -- guard is what makes this safe to lose rather than corrupt — same reasoning
  -- as decrement_usage's guard: it can never drive the balance negative, and a
  -- zeroed balance simply affects zero rows instead of erroring. The row's own
  -- current value is decremented under the UPDATE's row lock, so concurrent
  -- consumptions for the same profile serialize instead of clobbering.
  update public.profiles
  set credit_balance = credit_balance - 1
  where id = p_profile_id
    and credit_balance > 0
  returning credit_balance into v_new_balance;

  -- No row affected: the balance was already 0. No ledger row is written for a
  -- denial — the ledger records changes in credits, and nothing changed.
  if v_new_balance is null then
    return 'denied';
  end if;

  -- ref_analysis_id is left NULL: the analyses row does not exist yet at this
  -- point, which is the ordering constraint already documented on that column.
  insert into public.credit_ledger (profile_id, delta, reason, balance_after)
  values (p_profile_id, -1, 'analysis', v_new_balance);

  return 'credit';
end;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION: refund_credit
-- ---------------------------------------------------------------------------

-- Called by the analysis service when a credit was consumed via
-- check_and_consume_entitlement but the subsequent image upload or analyses
-- insert failed — the credit-side mirror of the existing quota compensation
-- (decrement_usage), and shaped exactly like it.
--
-- It carries the same accepted trade-offs already documented on
-- decrement_usage. The month-boundary race does not apply here, since credits
-- are not period-scoped and so no period argument is needed. The remaining
-- limitation does apply: if this refund itself fails, the credit is lost. That
-- is accepted for MVP, consistent with the existing policy.
--
-- SECURITY INVOKER for the same Trigger C reason as above: this function also
-- writes profiles.credit_balance.
create function public.refund_credit(p_profile_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new_balance int;
begin
  update public.profiles
  set credit_balance = credit_balance + 1
  where id = p_profile_id
  returning credit_balance into v_new_balance;

  insert into public.credit_ledger (profile_id, delta, reason, balance_after)
  values (p_profile_id, 1, 'refund', v_new_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only, same reasoning as every other entitlement-touching
-- function in this project: one gates access to a paid resource, the other
-- hands an entitlement back, so a client able to call either could mint itself
-- unlimited analyses.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC. Supabase
-- auto-grants EXECUTE on new public-schema functions directly to both roles, so
-- those grants are held in their own right and would survive a revoke from
-- PUBLIC alone.
revoke execute on function
  public.check_and_consume_entitlement(uuid),
  public.refund_credit(uuid)
  from public, anon, authenticated;

grant execute on function
  public.check_and_consume_entitlement(uuid),
  public.refund_credit(uuid)
  to service_role;
