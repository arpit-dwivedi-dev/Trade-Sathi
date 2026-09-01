-- ChartAnalyzer — one-off Daily Briefing credit packs.
--
-- The Daily Briefing add-on is a subscription, and a user may hold exactly one
-- live subscription per plan — buying the same subscription twice would charge
-- twice every month and grant nothing, because
-- check_and_consume_daily_briefing_entitlement derives its allowance from the
-- plan's daily_briefing_entitlements row, not from how many subscriptions
-- exist. Topping up WITHIN a month is therefore a one-time purchase, not a
-- second subscription: packs of 10 that stack (10 + 10 + 10), exactly as
-- manual analyses already work.
--
-- This mirrors the manual credit design (20260830230000, 20260830234500,
-- 20260830235500) rather than reusing it. Briefing credits and manual credits
-- are two separate currencies: one buys an automated watchlist run, the other
-- a user-initiated analysis, and they are priced differently. Sharing
-- profiles.credit_balance would let a briefing top-up be spent on manual
-- analyses; sharing credit_ledger would make its balance_after column — the
-- whole point of that column — unreconcilable against either balance.

-- ---------------------------------------------------------------------------
-- 1. PROFILES — briefing credit balance
-- ---------------------------------------------------------------------------

-- Denormalized running total, the fast path for the entitlement check.
-- daily_briefing_credit_ledger is the authoritative history. Written only by
-- the service role, exactly like credit_balance.
alter table public.profiles
  add column daily_briefing_credit_balance int not null default 0;

-- ---------------------------------------------------------------------------
-- 2. TRIGGER C — extend the protected-column list
-- ---------------------------------------------------------------------------

-- CREATE OR REPLACE of the function only; the trigger itself is untouched and
-- keeps pointing at this same function.
--
-- The new column is protected for the same reason credit_balance already is: a
-- client that can write it can mint itself briefing runs it never paid for.
--
-- Everything else about this function — SECURITY INVOKER (not DEFINER, so
-- current_user remains the real caller), the trusted-sync flag, search_path =
-- '' — is carried over unchanged. See the init migration for the full
-- reasoning.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'service_role'
     and coalesce(current_setting('chartanalyzer.trusted_profile_sync', true), 'off') <> 'on'
     and (
       new.plan_id                      is distinct from old.plan_id or
       new.email                        is distinct from old.email or
       new.email_verified               is distinct from old.email_verified or
       new.signup_source                is distinct from old.signup_source or
       new.detected_country_code        is distinct from old.detected_country_code or
       new.pricing_region               is distinct from old.pricing_region or
       new.pricing_region_source        is distinct from old.pricing_region_source or
       new.pricing_region_locked_at     is distinct from old.pricing_region_locked_at or
       new.credit_balance               is distinct from old.credit_balance or
       new.daily_briefing_credit_balance is distinct from old.daily_briefing_credit_balance
     )
  then
    raise exception 'Direct modification of protected profile columns is not allowed';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. TABLE: daily_briefing_credit_ledger
-- ---------------------------------------------------------------------------

-- Append-only record of every briefing-credit movement: +10 on a pack
-- purchase, -1 on consumption, +1 on refund. Shaped exactly like
-- credit_ledger, including the credit_reason enum, which already carries every
-- value this needs — a parallel enum would have identical members and one more
-- thing to keep in step.
create table public.daily_briefing_credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  delta           int not null,
  reason          credit_reason not null,
  -- The purchase that produced this grant; set when reason='pack_purchase'.
  -- ON DELETE SET NULL, not CASCADE, for the same reason as credit_ledger: if
  -- a payment row is ever removed the ledger row must survive without its
  -- reference rather than vanish.
  ref_payment_id  uuid references public.payments(id) on delete set null,
  -- The briefing analysis this credit was spent on. Legitimately NULL in the
  -- common case: the consume decision happens before the analyses row exists.
  ref_analysis_id uuid references public.analyses(id) on delete set null,
  -- Balance snapshot immediately after applying delta, for reconciliation
  -- against profiles.daily_briefing_credit_balance without replaying history.
  balance_after   int not null,
  created_at      timestamptz not null default now()
);

create index daily_briefing_credit_ledger_profile_id_created_at_idx
  on public.daily_briefing_credit_ledger (profile_id, created_at desc);

alter table public.daily_briefing_credit_ledger enable row level security;

-- Read-only for clients, matching credit_ledger exactly: writes must be atomic
-- with the balance update, so they happen only server-side via service role.
create policy daily_briefing_credit_ledger_select_own
  on public.daily_briefing_credit_ledger
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. FUNCTION: check_and_consume_daily_briefing_entitlement (replaced)
-- ---------------------------------------------------------------------------

-- Returns exactly one of:
--   'quota'           — a subscription quota unit was consumed.
--   'credit'          — quota was exhausted (or there is no subscription at
--                       all), one briefing credit was consumed and ledgered.
--   'no_subscription' — no live subscription AND no credits.
--   'quota_exhausted' — subscription is live, quota spent, no credits left.
--
-- 'consumed' is gone: the caller now has to know WHICH resource was spent, or
-- its compensating release would refund the wrong one — silently converting a
-- purchased credit into a quota refund, or a quota unit into a minted credit.
-- The manual side learned this already; see releaseEntitlement's doc comment
-- in apps/api/src/services/analysis.service.ts.
--
-- Credits are tried only AFTER quota, so a subscriber never burns a paid
-- top-up while free monthly allowance remains.
--
-- A user with credits but no subscription is served. Credits are bought
-- outright and their value cannot be conditional on holding a subscription
-- that may lapse — the alternative is money taken for runs that can never
-- happen.
--
-- SECURITY INVOKER, deliberately — NOT SECURITY DEFINER, and this is a CHANGE
-- from the previous definition. This function now writes
-- profiles.daily_briefing_credit_balance, which Trigger C guards by checking
-- current_user = 'service_role'; under DEFINER, current_user becomes the
-- function owner and the trigger would block the update. The real caller is
-- always the backend using the service role key, which holds the table
-- privileges the old DEFINER elevation was supplying — including on
-- daily_briefing_usage_counters and subscriptions.
create or replace function public.check_and_consume_daily_briefing_entitlement(p_profile_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Schema-qualified: with search_path = '' set on this function, PL/pgSQL
  -- resolves a DECLARE block's variable types against that empty path — an
  -- unqualified enum name here fails with "type does not exist".
  v_plan_key    public.plan_key;
  v_limit       int;
  v_period      text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_used        int;
  v_new_balance int;
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

  if v_plan_key is not null then
    select monthly_auto_analyses into v_limit
    from public.daily_briefing_entitlements
    where plan_key = v_plan_key;

    if v_limit is null then
      raise exception 'No daily_briefing_entitlements row for plan %', v_plan_key;
    end if;

    insert into public.daily_briefing_usage_counters (profile_id, period)
    values (p_profile_id, v_period)
    on conflict (profile_id, period) do nothing;

    -- FOR UPDATE, as before: the counter row is locked before being compared
    -- and incremented, so concurrent calls for the same profile serialize
    -- instead of both reading a stale count and overshooting the allowance.
    select uc.analyses_used into v_used
    from public.daily_briefing_usage_counters uc
    where uc.profile_id = p_profile_id
      and uc.period = v_period
    for update;

    if v_used is null then
      raise exception 'Daily briefing usage counter row missing for profile % period %',
        p_profile_id, v_period;
    end if;

    if v_used < v_limit then
      update public.daily_briefing_usage_counters
      set analyses_used = analyses_used + 1,
          updated_at = now()
      where profile_id = p_profile_id
        and period = v_period;

      return 'quota';
    end if;
  end if;

  -- Quota exhausted, or no subscription. Try one credit. The `> 0` guard is
  -- what makes this safe to lose rather than corrupt — it can never drive the
  -- balance negative, and a zeroed balance affects zero rows instead of
  -- erroring. The row's current value is decremented under the UPDATE's row
  -- lock, so concurrent consumptions for the same profile serialize.
  update public.profiles
  set daily_briefing_credit_balance = daily_briefing_credit_balance - 1
  where id = p_profile_id
    and daily_briefing_credit_balance > 0
  returning daily_briefing_credit_balance into v_new_balance;

  -- No row affected: the balance was already 0. No ledger row is written for a
  -- denial — the ledger records changes in credits, and nothing changed.
  if v_new_balance is null then
    if v_plan_key is null then
      return 'no_subscription';
    end if;
    return 'quota_exhausted';
  end if;

  -- ref_analysis_id is left NULL: the analyses row does not exist yet at this
  -- point, the same ordering constraint documented on that column.
  insert into public.daily_briefing_credit_ledger (profile_id, delta, reason, balance_after)
  values (p_profile_id, -1, 'analysis', v_new_balance);

  return 'credit';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. FUNCTION: refund_daily_briefing_credit
-- ---------------------------------------------------------------------------

-- The credit-side mirror of decrement_daily_briefing_usage, called when a
-- credit was consumed but the run failed before an analysis was durably
-- stored. Same accepted trade-off as every other compensation here: if this
-- refund itself fails the credit is lost, which is accepted for MVP.
--
-- No period argument: credits are not period-scoped, so the month-boundary
-- race that decrement_daily_briefing_usage guards against does not apply.
--
-- SECURITY INVOKER for the same Trigger C reason as above.
create function public.refund_daily_briefing_credit(p_profile_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new_balance int;
begin
  update public.profiles
  set daily_briefing_credit_balance = daily_briefing_credit_balance + 1
  where id = p_profile_id
  returning daily_briefing_credit_balance into v_new_balance;

  if v_new_balance is null then
    return;
  end if;

  insert into public.daily_briefing_credit_ledger (profile_id, delta, reason, balance_after)
  values (p_profile_id, 1, 'refund', v_new_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. FUNCTION: apply_daily_briefing_credit_purchase
-- ---------------------------------------------------------------------------

-- The briefing counterpart to apply_credit_purchase. Returns exactly one of:
--   'applied'         — credits granted, payment marked captured and ledgered.
--   'duplicate'       — this payment was already captured; nothing changed.
--   'order_not_found' — no local payments row for this order; nothing changed.
--
-- Kept separate from apply_credit_purchase rather than parameterised: the two
-- move different balances into different ledgers, and a single function taking
-- "which currency" would put the decision at the call site, where the webhook
-- would have to be trusted to get it right. Here the payment's own purpose
-- decides, and the webhook route only routes.
--
-- SECURITY INVOKER for the same Trigger C reason as apply_credit_purchase.
create function public.apply_daily_briefing_credit_purchase(
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
      -- Set here rather than at insert time: this function runs only after the
      -- webhook route has verified Razorpay's signature over the raw request
      -- body, which is precisely what this column records.
      signature_verified  = true,
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
-- 7. PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only, same reasoning as every other entitlement-touching
-- function in this project: a client able to call these could mint itself
-- briefing runs it never paid for.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC. Supabase
-- auto-grants EXECUTE on new public-schema functions directly to both roles,
-- so those grants are held in their own right and would survive a revoke from
-- PUBLIC alone. check_and_consume_daily_briefing_entitlement is re-revoked
-- because CREATE OR REPLACE above does not reset its grants but the explicit
-- restatement keeps this migration self-contained if it is ever replayed.
revoke execute on function
  public.check_and_consume_daily_briefing_entitlement(uuid),
  public.refund_daily_briefing_credit(uuid),
  public.apply_daily_briefing_credit_purchase(text, text)
  from public, anon, authenticated;

grant execute on function
  public.check_and_consume_daily_briefing_entitlement(uuid),
  public.refund_daily_briefing_credit(uuid),
  public.apply_daily_briefing_credit_purchase(text, text)
  to service_role;
