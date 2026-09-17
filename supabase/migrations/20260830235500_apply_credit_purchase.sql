-- TradeSathi — granting credits once a credit-pack payment is captured.
--
-- The one-time-purchase counterpart to apply_subscription_webhook: that
-- function applies recurring subscription events, this one applies a captured
-- Razorpay Order for a credit pack. They are kept separate because Orders and
-- Subscriptions share almost no lifecycle, exactly as payments and
-- subscriptions are separate tables.

-- ---------------------------------------------------------------------------
-- FUNCTION: apply_credit_purchase
-- ---------------------------------------------------------------------------

-- Returns exactly one of:
--   'applied'         — credits granted, payment marked captured and ledgered.
--   'duplicate'       — this payment was already captured; nothing changed.
--   'order_not_found' — no local payments row for this order; nothing changed.
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
  p_provider_payment_id text
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
      -- Set here rather than at insert time: the route only calls this
      -- function after Razorpay's webhook signature has been verified over the
      -- raw request body, which is precisely what this column records.
      signature_verified  = true,
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
-- PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only, same reasoning as every other entitlement-touching
-- function in this project: a client able to call this could mint itself
-- credits for an order it never paid for.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC. Supabase
-- auto-grants EXECUTE on new public-schema functions directly to both roles, so
-- those grants are held in their own right and would survive a revoke from
-- PUBLIC alone.
revoke execute on function
  public.apply_credit_purchase(text, text)
  from public, anon, authenticated;

grant execute on function
  public.apply_credit_purchase(text, text)
  to service_role;
