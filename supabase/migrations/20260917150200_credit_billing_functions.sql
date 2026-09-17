-- ChartAnalyzer — unified credit billing, part 3: the functions that move
-- profiles.credit_balance.
--
-- Replaces three independent check_and_consume_*/decrement_*/refund_*
-- families (manual quota+credit, Daily Briefing quota+credit, Fundamentals
-- flat cap) with one pair driven by feature_credit_costs, plus one purchase
-- function and one promo-redemption function.
--
-- SECURITY INVOKER on every function below, deliberately — NOT SECURITY
-- DEFINER. Every one of them writes profiles.credit_balance, which Trigger C
-- (protect_profile_columns) guards by checking current_user = 'service_role'.
-- Under SECURITY DEFINER, current_user inside the body becomes the
-- function's owner rather than the real caller, so Trigger C would see a
-- non-service_role current_user and block the write — the same class of bug
-- already fixed once for apply_subscription_webhook. The real caller is
-- always the backend using the service role key, which already holds
-- sufficient table privileges, so DEFINER's elevation buys nothing here and
-- only breaks the guard.
--
-- SET search_path = '' (empty) on every function hardens against
-- search_path hijacking, so every reference is fully qualified.

-- ---------------------------------------------------------------------------
-- FUNCTION: consume_credits
-- ---------------------------------------------------------------------------

-- Returns exactly one of:
--   'consumed'             — the feature's configured cost was deducted and
--                             ledgered.
--   'insufficient_credits' — balance was below the cost; nothing changed.
--
-- The `credit_balance >= v_cost` guard on the UPDATE is what makes this safe
-- to lose rather than corrupt — it can never drive the balance negative
-- (also backstopped by the profiles_credit_balance_non_negative check
-- constraint), and an insufficient balance simply affects zero rows instead
-- of erroring. The row's own current value is decremented under the
-- UPDATE's row lock, so concurrent consumptions for the same profile
-- serialize instead of both reading a stale balance and overshooting it.
create function public.consume_credits(
  p_profile_id      uuid,
  p_feature_key     text,
  p_ref_analysis_id uuid default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cost        int;
  v_new_balance int;
begin
  select credits into v_cost
  from public.feature_credit_costs
  where feature_key = p_feature_key
    and is_active = true;

  if v_cost is null then
    raise exception 'No active feature_credit_costs row for feature_key %', p_feature_key;
  end if;

  update public.profiles
  set credit_balance = credit_balance - v_cost
  where id = p_profile_id
    and credit_balance >= v_cost
  returning credit_balance into v_new_balance;

  if v_new_balance is null then
    return 'insufficient_credits';
  end if;

  -- ref_analysis_id is typically NULL here: the analyses row does not exist
  -- yet at this point, the same ordering constraint the old
  -- check_and_consume_entitlement documented on this column.
  insert into public.credit_ledger
    (profile_id, delta, reason, feature_key, ref_analysis_id, balance_after)
  values
    (p_profile_id, -v_cost, 'feature_consumption', p_feature_key, p_ref_analysis_id, v_new_balance);

  return 'consumed';
end;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION: refund_credits
-- ---------------------------------------------------------------------------

-- Called when consume_credits succeeded but the call site's actual work
-- (the AI call, the analyses insert) failed after — the credit-side mirror
-- of the old decrement_usage/refund_credit/refund_daily_briefing_credit
-- family, unified into one function driven by the same feature_credit_costs
-- lookup consume_credits uses, so the refunded amount always matches what
-- was actually taken.
--
-- Carries the same accepted trade-off the old refund functions documented:
-- if this refund itself fails, the credit is lost. Accepted for MVP.
create function public.refund_credits(
  p_profile_id      uuid,
  p_feature_key     text,
  p_ref_analysis_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cost        int;
  v_new_balance int;
begin
  select credits into v_cost
  from public.feature_credit_costs
  where feature_key = p_feature_key;

  if v_cost is null then
    raise exception 'No feature_credit_costs row for feature_key %', p_feature_key;
  end if;

  update public.profiles
  set credit_balance = credit_balance + v_cost
  where id = p_profile_id
  returning credit_balance into v_new_balance;

  insert into public.credit_ledger
    (profile_id, delta, reason, feature_key, ref_analysis_id, balance_after)
  values
    (p_profile_id, v_cost, 'refund', p_feature_key, p_ref_analysis_id, v_new_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION: admin_adjust_credits
-- ---------------------------------------------------------------------------

-- The manual/support escape hatch — a positive or negative correction with a
-- required note. Returns 'applied' or 'insufficient_credits' (a negative
-- adjustment that would drive the balance below zero is refused, not
-- clamped, so the caller sees the failure rather than a silently wrong
-- result).
create function public.admin_adjust_credits(
  p_profile_id uuid,
  p_delta      int,
  p_note       text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new_balance int;
begin
  if p_note is null or btrim(p_note) = '' then
    raise exception 'admin_adjust_credits requires a note';
  end if;

  update public.profiles
  set credit_balance = credit_balance + p_delta
  where id = p_profile_id
    and credit_balance + p_delta >= 0
  returning credit_balance into v_new_balance;

  if v_new_balance is null then
    return 'insufficient_credits';
  end if;

  insert into public.credit_ledger (profile_id, delta, reason, note, balance_after)
  values (p_profile_id, p_delta, 'admin_adjustment', p_note, v_new_balance);

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION: redeem_promo_code_credits
-- ---------------------------------------------------------------------------

-- The free-credits half of the promo system (the Redeem page). Discount
-- codes are handled separately, inline in the purchase-order flow
-- (credits.service.ts at order-creation time, finalized in
-- apply_credit_purchase below at capture time) rather than here — a discount
-- has no meaning without a purchase to apply it to.
--
-- Returns exactly one of:
--   'applied'             — credits granted, redemption recorded and
--                            ledgered.
--   'invalid_code'        — no such code, it is inactive, has no
--                            free_credits component, or has not started yet.
--                            Collapsed into one answer deliberately: telling
--                            a caller which guessed codes used to be real, or
--                            exist but do something else, is a free
--                            enumeration oracle.
--   'expired'             — the code's expiry has passed.
--   'exhausted'           — the code's global redemption cap is reached.
--   'not_eligible_region' — the code is restricted to other regions.
--   'duplicate'           — this account has already redeemed this code's
--                            free-credits component per_user_limit times.
--
-- The SELECT ... FOR UPDATE on promo_codes is what makes the cap race-proof,
-- exactly as in the old redeem_promo_code: two concurrent redemptions of the
-- same code serialize on the row lock, and the second sees the first's
-- incremented redemption_count rather than a stale copy.
create function public.redeem_promo_code_credits(
  p_profile_id uuid,
  p_code       text,
  p_region     pricing_region
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_code           public.promo_codes%rowtype;
  v_prior_count    int;
  v_new_balance    int;
begin
  select * into v_code
  from public.promo_codes
  where upper(code) = upper(btrim(p_code))
  for update;

  if not found or not v_code.is_active or v_code.free_credits is null then
    return 'invalid_code';
  end if;

  if v_code.starts_at is not null and now() < v_code.starts_at then
    return 'invalid_code';
  end if;

  if v_code.expires_at is not null and now() > v_code.expires_at then
    return 'expired';
  end if;

  if v_code.region_eligibility is not null
     and array_length(v_code.region_eligibility, 1) > 0
     and not (p_region = any (v_code.region_eligibility))
  then
    return 'not_eligible_region';
  end if;

  if v_code.max_redemptions is not null
     and v_code.redemption_count >= v_code.max_redemptions
  then
    return 'exhausted';
  end if;

  select count(*) into v_prior_count
  from public.promo_redemptions
  where code_id = v_code.id
    and profile_id = p_profile_id
    and redemption_type = 'free_credits';

  if v_prior_count >= v_code.per_user_limit then
    return 'duplicate';
  end if;

  update public.promo_codes
  set redemption_count = redemption_count + 1
  where id = v_code.id;

  update public.profiles
  set credit_balance = credit_balance + v_code.free_credits
  where id = p_profile_id
  returning credit_balance into v_new_balance;

  -- The caller is the backend, which resolves p_profile_id from a verified
  -- JWT — a miss here is a programming error, not a user input problem.
  if v_new_balance is null then
    raise exception 'No profile found for promo redemption: %', p_profile_id;
  end if;

  insert into public.promo_redemptions (code_id, profile_id, redemption_type, credits_granted)
  values (v_code.id, p_profile_id, 'free_credits', v_code.free_credits);

  insert into public.credit_ledger (profile_id, delta, reason, ref_promo_code_id, balance_after)
  values (p_profile_id, v_code.free_credits, 'promo_credit', v_code.id, v_new_balance);

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION: apply_credit_purchase (recreated for flexible quantity + promo)
-- ---------------------------------------------------------------------------

-- The purchase-side counterpart to consume_credits. Called from both the
-- Razorpay webhook (payment.captured) and the reconciliation endpoint
-- (verify-order) — same dual-path idempotency the old function had:
-- p_signature_verified states which of the two distinct facts the caller
-- established (webhook signature verified vs. this backend directly queried
-- Razorpay's Orders API), with no default, so a future caller cannot record
-- the weaker claim as the stronger one by omission.
--
-- Returns exactly one of:
--   'applied'         — credits granted, payment marked captured and
--                        ledgered, promo redemption recorded if one applied.
--   'duplicate'       — this payment was already captured; nothing changed.
--   'order_not_found' — no local payments row for this order; nothing
--                        changed.
--
-- Any promo discount was already computed and charged into this order's
-- amount at order-creation time (credits.service.ts) — this function only
-- finalizes the bookkeeping (increments the code's redemption_count, records
-- the promo_redemptions row) under the same row lock as the credit grant. It
-- deliberately does not re-validate the code's caps here: the customer has
-- already paid the discounted price, so a cap exhausted in the interim
-- cannot be un-charged, and refusing at this point would only make the audit
-- trail wrong, not the money.
create function public.apply_credit_purchase(
  p_provider_order_id   text,
  p_provider_payment_id text,
  p_signature_verified  boolean
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_payment     public.payments%rowtype;
  v_new_balance int;
begin
  -- FOR UPDATE: the status read below is the idempotency guard, and two
  -- concurrent deliveries (or a webhook racing the reconciliation endpoint)
  -- must not both observe a non-'captured' status and both grant credits.
  select * into v_payment
  from public.payments
  where provider_order_id = p_provider_order_id
  for update;

  if not found then
    return 'order_not_found';
  end if;

  if v_payment.status = 'captured' then
    return 'duplicate';
  end if;

  update public.payments
  set status              = 'captured',
      provider_payment_id = p_provider_payment_id,
      signature_verified  = p_signature_verified,
      captured_at         = now()
  where id = v_payment.id;

  update public.profiles
  set credit_balance = credit_balance + v_payment.credits_purchased
  where id = v_payment.profile_id
  returning credit_balance into v_new_balance;

  insert into public.credit_ledger (profile_id, delta, reason, ref_payment_id, balance_after)
  values (v_payment.profile_id, v_payment.credits_purchased, 'purchase', v_payment.id, v_new_balance);

  if v_payment.promo_code_id is not null then
    update public.promo_codes
    set redemption_count = redemption_count + 1
    where id = v_payment.promo_code_id;

    insert into public.promo_redemptions
      (code_id, profile_id, redemption_type, discount_applied_minor, ref_payment_id)
    values
      (v_payment.promo_code_id, v_payment.profile_id, 'discount', v_payment.discount_minor, v_payment.id);
  end if;

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only, same reasoning as every entitlement/purchase function
-- this replaces: a client able to call any of these could mint itself
-- credits, spend someone else's balance, or redeem a code it never validated
-- against.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC.
-- Supabase auto-grants EXECUTE on new public-schema functions directly to
-- both roles, so those grants are held in their own right and would survive
-- a revoke from PUBLIC alone.
revoke execute on function
  public.consume_credits(uuid, text, uuid),
  public.refund_credits(uuid, text, uuid),
  public.admin_adjust_credits(uuid, int, text),
  public.redeem_promo_code_credits(uuid, text, pricing_region),
  public.apply_credit_purchase(text, text, boolean)
  from public, anon, authenticated;

grant execute on function
  public.consume_credits(uuid, text, uuid),
  public.refund_credits(uuid, text, uuid),
  public.admin_adjust_credits(uuid, int, text),
  public.redeem_promo_code_credits(uuid, text, pricing_region),
  public.apply_credit_purchase(text, text, boolean)
  to service_role;
