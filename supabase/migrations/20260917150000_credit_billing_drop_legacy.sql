-- TradeSathi — unified credit billing, part 1: drop everything the old
-- plan/subscription/quota model owned.
--
-- There are no real paying subscribers yet (confirmed with the product
-- owner) — this is a clean cutover, not a migration of live data, so old
-- tables/functions/columns/enums are dropped outright rather than
-- soft-deprecated. Three independent entitlement pools (manual quota+credit,
-- Daily Briefing subscription+credit, Fundamentals flat cap) are being
-- replaced by one credit balance/ledger — see the following migrations in
-- this batch (…150100 schema, …150200 functions, …150300 seed).

-- ---------------------------------------------------------------------------
-- 1. FUNCTIONS
-- ---------------------------------------------------------------------------

-- Dropped before the tables/enums they reference, and before the enums are
-- dropped (a function's parameter/return types must not still be in use when
-- its owning enum is dropped).
drop function if exists public.apply_subscription_webhook(
  text, text, timestamptz, text, subscription_status, timestamptz, timestamptz, timestamptz, text
);
drop function if exists public.check_and_consume_daily_briefing_entitlement(uuid);
drop function if exists public.decrement_daily_briefing_usage(uuid, text);
drop function if exists public.refund_daily_briefing_credit(uuid);
drop function if exists public.apply_daily_briefing_credit_purchase(text, text, boolean);
drop function if exists public.check_and_consume_fundamentals_entitlement(uuid);
drop function if exists public.decrement_fundamentals_usage(uuid, text);
drop function if exists public.check_and_consume_entitlement(uuid);
drop function if exists public.refund_credit(uuid);
drop function if exists public.check_and_increment_usage(uuid);
drop function if exists public.decrement_usage(uuid, text);
drop function if exists public.redeem_promo_code(uuid, text);
drop function if exists public.apply_credit_purchase(text, text, boolean);

-- ---------------------------------------------------------------------------
-- 2. PROFILES — drop the plan slot and the second credit currency BEFORE the
--    tables/columns they reference, so the plans/subscriptions drops below
--    never hit a dangling FK (profiles_plan_id_fkey in particular).
-- ---------------------------------------------------------------------------

-- handle_new_user() (init migration) looks up the free plan and assigns
-- plan_id on every signup; it must stop doing that BEFORE plans/plan_id are
-- gone, or every future signup errors. Postgres does not track a plpgsql
-- function body's reference to a table as a hard dependency (unlike a view),
-- so dropping plans further down would have silently succeeded with this
-- function left broken had this update not been made first.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null then
    raise exception 'Cannot create profile: auth.users.email is null';
  end if;

  insert into public.profiles (id, email, email_verified)
  values (
    new.id,
    new.email,
    (new.email_confirmed_at is not null)
  );

  return new;
end;
$$;

alter table public.profiles drop column if exists plan_id;
alter table public.profiles drop column if exists daily_briefing_credit_balance;

-- detected_country_code / pricing_region / pricing_region_source /
-- pricing_region_locked_at / credit_balance all stay: region detection and
-- the single credit balance are still load-bearing, just no longer tied to a
-- plan. protect_profile_columns() is updated for the new column set in the
-- next migration (…150100_credit_billing_schema.sql), alongside the other
-- schema changes it needs to know about (credit_ledger's new shape).

-- ---------------------------------------------------------------------------
-- 3. TABLES — dropped children-before-parents so FKs never block a drop.
-- ---------------------------------------------------------------------------

drop table if exists public.daily_briefing_credit_ledger;
drop table if exists public.credit_ledger;
drop table if exists public.promo_redemptions;
drop table if exists public.promo_codes;

-- Unused once subscription webhooks are gone: it existed solely to dedupe
-- Razorpay's x-razorpay-event-id for subscription.* events (payment.captured
-- dedupes on payments.status instead, which is untouched by this). No other
-- code path reads or writes it.
drop table if exists public.webhook_events;

drop table if exists public.subscriptions;
drop table if exists public.daily_briefing_entitlements;
drop table if exists public.daily_briefing_usage_counters;
drop table if exists public.fundamentals_usage_counters;
drop table if exists public.usage_counters;
drop table if exists public.plan_prices;
drop table if exists public.plans;

-- ---------------------------------------------------------------------------
-- 4. ENUMS — dropped last, once nothing (table column or function
--    parameter/return type) still holds a value of that type.
-- ---------------------------------------------------------------------------

drop type if exists plan_key;
drop type if exists subscription_status;
drop type if exists webhook_result;
-- billing_provider stays: public.payments.provider still uses it, and it is
-- still meaningful — reserved for a future second provider exactly as
-- originally documented, unaffected by subscriptions going away.
-- credit_reason is recreated with a new set of values in the next migration;
-- drop it here since credit_ledger/daily_briefing_credit_ledger (the only
-- columns that used it) are already gone.
drop type if exists credit_reason;
