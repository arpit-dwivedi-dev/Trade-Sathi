-- ChartAnalyzer — atomic Razorpay subscription webhook application.
--
-- One function that performs the entire webhook-processing write as a single
-- transaction: idempotency ledger insert, out-of-order rejection, subscription
-- sync, and the entitlement change on profiles.plan_id. Doing these as separate
-- statements from application code would leave the ledger and the entitlement
-- able to diverge if the process died between them.
--
-- SQL only. The Express route and signature verification that will call this
-- are a separate task.

-- ---------------------------------------------------------------------------
-- 1. COLUMN: subscriptions.last_event_at
-- ---------------------------------------------------------------------------

-- The webhook envelope's own created_at — when Razorpay *generated* the
-- notification, not when it was delivered here — for whichever event was last
-- actually applied to this row.
--
-- Razorpay explicitly documents that webhook delivery order is not guaranteed
-- ("you may not always receive the webhooks in order... configure your webhook
-- URL to not expect delivery in this order"). Two events for the same
-- subscription can therefore arrive in the opposite order from which they were
-- generated. This column is what lets the function below reject an incoming
-- event that is not newer than what has already been applied, so a
-- late-arriving stale webhook can never overwrite more current state with older
-- data.
--
-- Nullable: a subscription has no prior applied event before its first webhook.
alter table public.subscriptions
  add column last_event_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. FUNCTION: apply_subscription_webhook
-- ---------------------------------------------------------------------------

-- Returns exactly one of: 'applied', 'duplicate', 'stale',
-- 'subscription_not_found'.
--
-- p_event_created_at is the webhook envelope's own top-level created_at field,
-- NOT payload.subscription.entity.created_at. The envelope value is when
-- Razorpay generated the event, which is the correct ordering signal. The Node
-- layer calling this is responsible for converting Razorpay's Unix-timestamp
-- created_at into a timestamptz before the call.
--
-- SECURITY INVOKER — deliberately the opposite of check_and_increment_usage and
-- decrement_usage, which are SECURITY DEFINER.
--
-- This function updates profiles.plan_id, which Trigger C
-- (public.protect_profile_columns) guards by checking current_user =
-- 'service_role'. Under SECURITY DEFINER, current_user inside the function body
-- becomes the function's *owner* (e.g. postgres) for the duration of the call
-- rather than the actual caller — so Trigger C would see the wrong identity and
-- raise 'Direct modification of protected profile columns is not allowed',
-- blocking a legitimate update. Under SECURITY INVOKER, current_user remains
-- the real caller and Trigger C's check behaves as intended.
--
-- The privilege elevation SECURITY DEFINER exists to provide is not needed
-- here: the real caller is this project's backend using the service role key,
-- which already holds sufficient table privileges on webhook_events,
-- subscriptions and profiles. Invoker mode is therefore both sufficient and
-- necessary.
--
-- SET search_path = '' (empty) hardens against search_path hijacking, so every
-- table reference below is fully qualified.
create function public.apply_subscription_webhook(
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
  v_plan_id        uuid;
begin
  -- -------------------------------------------------------------------------
  -- Step 1: idempotency insert. MUST be the first statement in the body,
  -- before any other read or write, so a duplicate delivery never reaches any
  -- subsequent logic.
  -- -------------------------------------------------------------------------
  insert into public.webhook_events (provider, event_id, event_type)
  values ('razorpay', p_event_id, p_event_type)
  on conflict (provider, event_id) do nothing
  returning id into v_event_id;

  -- No row inserted means the conflict target matched: this delivery has been
  -- seen before. Acknowledge and stop.
  if v_event_id is null then
    return 'duplicate';
  end if;

  -- -------------------------------------------------------------------------
  -- Step 2: locate the subscription this event refers to.
  -- -------------------------------------------------------------------------
  select s.id, s.profile_id, s.last_event_at
    into v_subscription
    from public.subscriptions s
   where s.provider_subscription_id = p_provider_subscription_id;

  -- Deliberately not an exception. Raising here would roll back the
  -- webhook_events insert above, so the delivery would never be recorded as
  -- seen and Razorpay would retry indefinitely for a condition that cannot
  -- self-resolve. Instead the ledger row is corrected to reflect that
  -- processing was not applied, rather than being left at its default
  -- 'applied'.
  if not found then
    update public.webhook_events
       set result = 'error',
           error  = 'subscription_not_found'
     where id = v_event_id;

    return 'subscription_not_found';
  end if;

  -- -------------------------------------------------------------------------
  -- Step 3: ordering check.
  -- -------------------------------------------------------------------------
  -- Not strictly newer than what has already been applied — either a genuine
  -- out-of-order late arrival, or a duplicate-timestamp tie. Both are treated
  -- the same way: conservatively not reapplied.
  --
  -- The webhook_events row stays at its default 'applied'. Nothing errored —
  -- this event was correctly received and correctly not acted on.
  if v_subscription.last_event_at is not null
     and p_event_created_at <= v_subscription.last_event_at then
    return 'stale';
  end if;

  -- -------------------------------------------------------------------------
  -- Step 4: sync the subscription row. Reached only when this event is
  -- strictly newer, or when last_event_at is NULL (the first event ever seen
  -- for this row).
  -- -------------------------------------------------------------------------
  update public.subscriptions s
     set status               = p_status,
         current_period_start = p_current_period_start,
         current_period_end   = p_current_period_end,
         charge_at            = p_charge_at,
         -- Once known, the customer id is never overwritten by a later
         -- payload that happens to omit it.
         provider_customer_id = coalesce(s.provider_customer_id, p_provider_customer_id),
         last_event_at        = p_event_created_at,
         updated_at           = now()
   where s.id = v_subscription.id;

  -- -------------------------------------------------------------------------
  -- Step 5: entitlement rule.
  -- -------------------------------------------------------------------------
  -- This is the actual authorization decision. It is kept deliberately narrow
  -- and explicit — an exhaustive listing of which statuses grant, which revoke,
  -- and which do neither — rather than inferred generically from status
  -- transitions. Getting this wrong in either direction leaves a user either
  -- paid-but-locked-out or unpaid-but-still-entitled.
  if p_status = 'active' then
    -- Confirmed billing: grant or restore paid access.
    select p.id into v_plan_id from public.plans p where p.key = 'pro_monthly';

    update public.profiles
       set plan_id = v_plan_id
     where id = v_subscription.profile_id;

  elsif p_status in ('halted', 'cancelled', 'expired', 'completed') then
    -- Terminal-or-dead states, none of which has an automatic path back to
    -- billing. Revoke to free.
    select p.id into v_plan_id from public.plans p where p.key = 'free';

    update public.profiles
       set plan_id = v_plan_id
     where id = v_subscription.profile_id;

  -- else: p_status in ('created', 'authenticated', 'pending', 'paused') —
  -- profiles.plan_id is deliberately left untouched.
  --
  --   'created' / 'authenticated' — pre-billing setup states. Nothing has been
  --     charged yet, so there is no paid access to grant.
  --   'pending' — an auto-charge failed and Razorpay is retrying. The user must
  --     keep whatever access they currently have; revoking mid-retry would
  --     lock out a user whose payment is about to succeed.
  --   'paused' — this project has not decided a resume/cancel-on-pause policy.
  --     Leaving current access untouched is deliberate rather than guessing a
  --     policy here. Revisit this explicitly when a pause/resume feature is
  --     actually built; do not infer a policy from this branch's silence.
  end if;

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. PERMISSIONS
-- ---------------------------------------------------------------------------

-- Same reasoning as check_and_increment_usage: this function grants and revokes
-- paid entitlement, so it must never be callable directly by a client role.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC. Supabase
-- auto-grants EXECUTE on new public-schema functions directly to both roles, so
-- those grants are held in their own right and would survive a revoke from
-- PUBLIC alone.
revoke execute on function public.apply_subscription_webhook(
  text, text, timestamptz, text, subscription_status, timestamptz, timestamptz,
  timestamptz, text
) from public, anon, authenticated;

grant execute on function public.apply_subscription_webhook(
  text, text, timestamptz, text, subscription_status, timestamptz, timestamptz,
  timestamptz, text
) to service_role;
