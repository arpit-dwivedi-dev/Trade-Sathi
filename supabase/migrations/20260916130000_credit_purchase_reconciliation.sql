-- ChartAnalyzer — reconciling a credit purchase against Razorpay directly.
--
-- Until now the ONLY thing that could mark a payments row 'captured' was the
-- payment.captured webhook. That is a single point of failure with no recovery:
-- if the delivery is never made (it cannot be made at all to a local dev
-- server, which Razorpay has no route to), is dropped, or fails signature
-- verification, the customer has paid and nothing in the system can notice.
-- The client polls the payments row, sees 'created' forever, times out, and
-- offers the purchase again.
--
-- The fix adds a second, independent way to establish the same fact: ask
-- Razorpay whether the Order is paid (razorpay.orders.fetchPayments) and grant
-- off that. Both paths converge on the functions below, so the grant stays in
-- one place and the idempotency guard stays in one place.
--
-- That convergence is exactly why this migration exists. The old functions
-- hardcoded signature_verified = true, which is a claim only the webhook path
-- can make — it records that a signature was checked over the raw request body
-- the provider sent. Reconciliation verifies against the provider's API
-- instead. Both are trustworthy; they are not the same fact, and recording one
-- as the other would put a falsehood in the audit trail. So the column becomes
-- an argument the caller must state, with no default to fall back on.

-- ---------------------------------------------------------------------------
-- 1. FUNCTION: apply_credit_purchase (signature changed)
-- ---------------------------------------------------------------------------

-- DROP then CREATE, not CREATE OR REPLACE: Postgres identifies a function by
-- name AND argument list, so adding a parameter under CREATE OR REPLACE would
-- leave the old 2-argument version in place as an overload alongside the new
-- one — and a call with two named arguments would then be ambiguous, failing at
-- runtime rather than here. Dropping first is the only way to actually replace
-- it. Nothing else in the schema calls this function, so nothing depends on it.
drop function public.apply_credit_purchase(text, text);

-- Returns exactly one of:
--   'applied'         — credits granted, payment marked captured and ledgered.
--   'duplicate'       — this payment was already captured; nothing changed.
--   'order_not_found' — no local payments row for this order; nothing changed.
--
-- p_signature_verified is what the caller actually established, and the two
-- callers establish different things:
--   true  — the webhook route verified Razorpay's signature over the raw body.
--   false — this backend asked Razorpay about the Order's payments directly and
--           saw one captured.
-- It has NO default on purpose. A default would let a future caller omit it and
-- silently write the weaker claim as the stronger one.
--
-- SECURITY INVOKER, deliberately — NOT SECURITY DEFINER, for exactly the same
-- reason as check_and_consume_entitlement: this function updates
-- profiles.credit_balance, which Trigger C (protect_profile_columns) guards by
-- checking current_user = 'service_role'. Under SECURITY DEFINER, current_user
-- inside the body becomes the function's owner rather than the real caller, so
-- Trigger C would see a non-service_role current_user and block the update.
-- The real caller is always the backend using the service role key, which
-- already holds sufficient table privileges, so DEFINER's elevation buys
-- nothing and only breaks the guard.
--
-- SET search_path = '' (empty) hardens it against search_path hijacking, so
-- every reference below is fully qualified.
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
  -- FOR UPDATE, not a plain SELECT: the status read below is the idempotency
  -- guard, and two concurrent deliveries of the same payment.captured event
  -- must not both observe a non-'captured' status and both grant credits. The
  -- row lock serializes them, so the second one sees 'captured' and returns
  -- 'duplicate'.
  --
  -- This lock is now load-bearing for a second reason: the webhook and the
  -- reconciliation path can race on the same order, and this is what makes that
  -- race safe rather than double-granting.
  select * into v_payment
  from public.payments
  where provider_order_id = p_provider_order_id
  for update;

  if not found then
    return 'order_not_found';
  end if;

  -- The payment's own status is the idempotency key here. Subscription
  -- webhooks dedupe on (provider, event_id) via the webhook_events ledger;
  -- payments has no such ledger, and does not need one — a credit pack is
  -- captured exactly once, so the terminal status is itself sufficient.
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
  set credit_balance = credit_balance + v_payment.credits_granted
  where id = v_payment.profile_id
  returning credit_balance into v_new_balance;

  insert into public.credit_ledger
    (profile_id, delta, reason, ref_payment_id, balance_after)
  values
    (v_payment.profile_id, v_payment.credits_granted, 'pack_purchase',
     v_payment.id, v_new_balance);

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. FUNCTION: apply_daily_briefing_credit_purchase (signature changed)
-- ---------------------------------------------------------------------------

-- The same change, for the same reason. The two functions are deliberately not
-- merged — see the long note above the original definition: the payment's own
-- purpose decides which balance moves, so the call site is never trusted to.
-- Adding a provenance argument does not change that.
drop function public.apply_daily_briefing_credit_purchase(text, text);

-- Returns exactly one of:
--   'applied'         — credits granted, payment marked captured and ledgered.
--   'duplicate'       — this payment was already captured; nothing changed.
--   'order_not_found' — no local payments row for this order; nothing changed.
--
-- SECURITY INVOKER for the same Trigger C reason as apply_credit_purchase.
create function public.apply_daily_briefing_credit_purchase(
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
  -- FOR UPDATE, not a plain SELECT: the status read below is the idempotency
  -- guard, and two concurrent deliveries of the same payment.captured event
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
  set daily_briefing_credit_balance = daily_briefing_credit_balance + v_payment.credits_granted
  where id = v_payment.profile_id
  returning daily_briefing_credit_balance into v_new_balance;

  insert into public.daily_briefing_credit_ledger
    (profile_id, delta, reason, ref_payment_id, balance_after)
  values
    (v_payment.profile_id, v_payment.credits_granted, 'pack_purchase',
     v_payment.id, v_new_balance);

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. COLUMN COMMENT: what signature_verified now means
-- ---------------------------------------------------------------------------

-- The original comment ("Never trust a 'captured' row whose signature was not
-- verified.") was written when the webhook was the only way a row could be
-- captured, and it now describes a state that is legitimate. Restated rather
-- than left to mislead whoever reads it next.
comment on column public.payments.signature_verified is
  'Whether Razorpay''s signature over the webhook body was verified for this payment. False on a captured row means the capture was established the other way: this backend fetched the Order''s payments from Razorpay''s API and saw one captured. Either is a verified capture; a captured row with a null captured_at is the only genuinely untrustworthy case, and no code path can write one.';

-- ---------------------------------------------------------------------------
-- 4. PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only, same reasoning as every other entitlement-touching
-- function in this project: a client able to call these could mint itself
-- credits for an order it never paid for.
--
-- The explicit revoke matters more than usual here: dropping a function drops
-- its grants with it, but Supabase auto-grants EXECUTE on new public-schema
-- functions directly to anon and authenticated. Those grants are held in their
-- own right and would survive a revoke from PUBLIC alone.
revoke execute on function
  public.apply_credit_purchase(text, text, boolean),
  public.apply_daily_briefing_credit_purchase(text, text, boolean)
  from public, anon, authenticated;

grant execute on function
  public.apply_credit_purchase(text, text, boolean),
  public.apply_daily_briefing_credit_purchase(text, text, boolean)
  to service_role;
