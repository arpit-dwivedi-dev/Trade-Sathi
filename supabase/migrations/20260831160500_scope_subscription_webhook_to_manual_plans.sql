-- Fix apply_subscription_webhook for the new Daily Briefing SKU.
--
-- profiles.plan_id is a single slot representing a user's ONE manual-analysis
-- plan (free / starter_monthly / pro_monthly / pro_annual) — check_and_increment_usage
-- reads it directly. The existing function unconditionally granted/revoked
-- 'pro_monthly'/'free' on ANY subscription webhook, and always granted
-- 'pro_monthly' regardless of which plan was actually purchased. That second
-- part was already a latent bug (any non-pro_monthly manual plan would be
-- mis-granted); it becomes actively harmful now that 'daily_briefing_monthly'
-- subscriptions flow through the same webhook — without this fix, a Daily
-- Briefing purchase or cancellation would overwrite a user's real manual plan
-- with 'pro_monthly' or 'free'.
--
-- Fix: resolve the plan actually attached to the subscription row, and only
-- touch profiles.plan_id when that plan is a manual-analysis plan (i.e. NOT
-- 'daily_briefing_monthly'). A Daily Briefing subscription's entitlement is
-- entirely tracked via public.subscriptions +
-- check_and_consume_daily_briefing_entitlement, never via profiles.plan_id —
-- so for that plan, this function now correctly does nothing to profiles.
--
-- Everything else (idempotency insert, ordering check, subscriptions row
-- sync) is unchanged from the original migration; only the "Step 5:
-- entitlement rule" section differs, plus fetching s.plan_id in Step 2's
-- lookup so Step 5 can resolve the purchased plan's key.
create or replace function public.apply_subscription_webhook(
  p_event_id                 text,
  p_event_type               text,
  p_event_created_at         timestamptz,
  p_provider_subscription_id text,
  p_status                   subscription_status,
  p_current_period_start     timestamptz,
  p_current_period_end       timestamptz,
  p_charge_at                timestamptz,
  p_provider_customer_id     text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event_id       uuid;
  v_subscription   record;
  -- Schema-qualified: see the identical note in
  -- 20260831160400_daily_briefing_entitlement_functions.sql — a DECLARE
  -- block's types resolve against this function's own search_path = '',
  -- unlike a parameter list, so an unqualified enum name fails here.
  v_purchased_key  public.plan_key;
  v_plan_id        uuid;
begin
  insert into public.webhook_events (provider, event_id, event_type)
  values ('razorpay', p_event_id, p_event_type)
  on conflict (provider, event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return 'duplicate';
  end if;

  select s.id, s.profile_id, s.plan_id, s.last_event_at
    into v_subscription
    from public.subscriptions s
   where s.provider_subscription_id = p_provider_subscription_id;

  if not found then
    update public.webhook_events
       set result = 'error',
           error  = 'subscription_not_found'
     where id = v_event_id;

    return 'subscription_not_found';
  end if;

  if v_subscription.last_event_at is not null
     and p_event_created_at <= v_subscription.last_event_at then
    return 'stale';
  end if;

  update public.subscriptions s
     set status               = p_status,
         current_period_start = p_current_period_start,
         current_period_end   = p_current_period_end,
         charge_at            = p_charge_at,
         provider_customer_id = coalesce(s.provider_customer_id, p_provider_customer_id),
         last_event_at        = p_event_created_at,
         updated_at           = now()
   where s.id = v_subscription.id;

  -- -------------------------------------------------------------------------
  -- Step 5: entitlement rule — now scoped to the plan actually purchased.
  -- -------------------------------------------------------------------------
  select pl.key into v_purchased_key
  from public.plans pl
  where pl.id = v_subscription.plan_id;

  if v_purchased_key = 'daily_briefing_monthly' then
    -- This SKU's entitlement lives entirely in public.subscriptions (read by
    -- check_and_consume_daily_briefing_entitlement) and never in
    -- profiles.plan_id. Deliberately do nothing here — a user's manual plan
    -- must be unaffected by buying, cancelling, or the lifecycle of a Daily
    -- Briefing add-on.
    return 'applied';
  end if;

  if p_status = 'active' then
    -- Confirmed billing: grant the plan actually purchased, not a hardcoded
    -- 'pro_monthly' — the original bug this migration also fixes.
    update public.profiles
       set plan_id = v_subscription.plan_id
     where id = v_subscription.profile_id;

  elsif p_status in ('halted', 'cancelled', 'expired', 'completed') then
    select p.id into v_plan_id from public.plans p where p.key = 'free';

    update public.profiles
       set plan_id = v_plan_id
     where id = v_subscription.profile_id;

  -- else: p_status in ('created', 'authenticated', 'pending', 'paused') —
  -- profiles.plan_id is deliberately left untouched. See the original
  -- migration (20260830220500_apply_subscription_webhook.sql) for the
  -- per-status reasoning; unchanged here.
  end if;

  return 'applied';
end;
$$;
