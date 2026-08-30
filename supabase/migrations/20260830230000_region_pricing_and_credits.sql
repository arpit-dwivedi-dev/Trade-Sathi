-- ChartAnalyzer — region-based pricing and the credit system.
--
-- Schema + seed data only. No application code reads or writes any of this yet:
-- the region-detection path, the credit-purchase backend and the atomic
-- entitlement function are all separate follow-up tasks.

-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------

-- Two price bands, not per-country pricing. This mirrors standard PPP-pricing
-- practice — group countries into a small number of bands rather than
-- maintaining 195 individual prices. A third band later (e.g. a
-- lower-income-market tier) is a cheap ALTER TYPE ... ADD VALUE, so starting
-- with two is not a restriction we have to undo.
create type pricing_region as enum ('IN', 'GLOBAL');

-- Why a credit_ledger row exists. 'adjustment' is the manual/support escape
-- hatch; every other value corresponds to an automated code path.
create type credit_reason as enum (
  'pack_purchase',
  'analysis',
  'refund',
  'promo',
  'adjustment'
);

-- ---------------------------------------------------------------------------
-- 2. TABLE: plan_prices
-- ---------------------------------------------------------------------------

-- The CURRENT list price of each (plan, region) pair, as shown to new signups.
--
-- This is deliberately NOT a historical/versioned price ledger. When a price
-- changes, the row is updated in place and the old value is simply gone —
-- which is safe because what a specific customer actually pays is recorded
-- independently at purchase time in subscriptions.amount_minor and
-- payments.amount_minor. Those are the audit trail; this table is the price
-- list.
--
-- The reason a plan's price is a separate table rather than more columns on
-- plans: Razorpay plan objects are currency-bound at creation time, so one
-- logical plan (pro_monthly) needs a different razorpay_plan_id per region, not
-- just a different number.
create table public.plan_prices (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.plans(id) on delete cascade,
  region          pricing_region not null,
  -- ISO 4217, e.g. 'INR', 'USD'. Not derived from region in code: a region's
  -- billing currency is a business decision, not a lookup.
  currency        text not null,
  -- Paise/cents. Money is always an integer minor unit, never a float.
  amount_minor    int not null,
  -- Razorpay's plan_xxx for this region. Nullable: the free plan has no
  -- Razorpay plan object in any region.
  razorpay_plan_id text,
  -- Temporarily unpublish a plan/region combination from new signups without
  -- deleting its price data. Not a versioning flag — there is only ever one row
  -- per (plan, region).
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Exactly one price row per plan per region, always current.
create unique index plan_prices_plan_id_region_key
  on public.plan_prices (plan_id, region);

-- -- SEED --------------------------------------------------------------------

-- pro_monthly / IN. The Razorpay plan id is SELECTed from the existing
-- plans.razorpay_plan_id column (populated by the plans_razorpay_plan_id
-- migration) rather than restated here, so there is exactly one place in the
-- database where that real plan_xxx value lives and no chance of the two
-- drifting apart.
insert into public.plan_prices (plan_id, region, currency, amount_minor, razorpay_plan_id)
select id, 'IN', 'INR', price_inr_paise, razorpay_plan_id
from public.plans
where key = 'pro_monthly';

-- No pro_monthly / GLOBAL row yet. That Razorpay plan does not exist until
-- international payments are activated on the account and a USD plan is created
-- in the Razorpay dashboard — a manual step, deliberately not part of this
-- migration. Seeding a placeholder row here would publish a price we cannot
-- actually charge.

-- free / both regions. Free is purchasable-by-nobody but must still resolve to
-- a price row in every region, so the future pricing lookup has no special case
-- for it.
insert into public.plan_prices (plan_id, region, currency, amount_minor, razorpay_plan_id)
select id, 'IN', 'INR', 0, null
from public.plans
where key = 'free';

insert into public.plan_prices (plan_id, region, currency, amount_minor, razorpay_plan_id)
select id, 'GLOBAL', 'USD', 0, null
from public.plans
where key = 'free';

alter table public.plan_prices enable row level security;

-- Public pricing data, same pattern as plans itself: readable by anon and
-- authenticated so the pricing page can render before login. No client write
-- policies — prices are written only by migrations or the service role.
create policy plan_prices_select_active on public.plan_prices
  for select
  to anon, authenticated
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- 3. PROFILES — region columns
-- ---------------------------------------------------------------------------

-- Raw ISO 3166-1 alpha-2 from IP geolocation, e.g. 'IN', 'US', 'DE'. Kept
-- alongside pricing_region rather than discarded after mapping, so a later
-- re-banding (adding a third tier) can be applied to existing users without
-- re-detecting them.
alter table public.profiles
  add column detected_country_code text;

-- The price band this user is billed in. Nullable until first detection.
--
-- This does NOT change automatically on subsequent visits or renewals, even if
-- the user's detected location later differs. That is deliberate: re-deriving
-- it per visit would show a user different prices across visits because of a
-- VPN or network path change, and would silently reprice an existing
-- subscriber. It changes only through an explicit manual override (a future
-- settings action, not built here), which sets pricing_region_source='manual'.
alter table public.profiles
  add column pricing_region pricing_region;

-- How pricing_region was arrived at: 'geoip' | 'manual'.
alter table public.profiles
  add column pricing_region_source text;

-- When pricing_region was FIRST set — the lock timestamp behind the
-- no-automatic-changes rule above.
alter table public.profiles
  add column pricing_region_locked_at timestamptz;

-- ---------------------------------------------------------------------------
-- 4. PROFILES — credit balance
-- ---------------------------------------------------------------------------

-- Denormalized current credit balance, the fast path for entitlement checks.
-- credit_ledger is the authoritative history; this is the running total, and
-- the two are reconciled via credit_ledger.balance_after. Written only by the
-- service role (a future atomic function), exactly like usage_counters.
alter table public.profiles
  add column credit_balance int not null default 0;

-- ---------------------------------------------------------------------------
-- 5. TRIGGER C — extend the protected-column list
-- ---------------------------------------------------------------------------

-- CREATE OR REPLACE of the function only; the trigger itself is untouched and
-- keeps pointing at this same function.
--
-- The five new columns are protected for the same reason plan_id and email
-- already are: a client that can write them can grant itself a cheaper price
-- band, mark that band as verified, backdate or refresh its lock timestamp to
-- re-trigger detection, or mint itself credits. All five are service-role-only.
--
-- Everything else about this function — SECURITY INVOKER (not DEFINER, so
-- current_user remains the real caller), the trusted-sync flag, search_path =
-- '' — is carried over unchanged from the init migration. See that migration
-- for the full reasoning.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'service_role'
     and coalesce(current_setting('chartanalyzer.trusted_profile_sync', true), 'off') <> 'on'
     and (
       new.plan_id                  is distinct from old.plan_id or
       new.email                    is distinct from old.email or
       new.email_verified           is distinct from old.email_verified or
       new.signup_source            is distinct from old.signup_source or
       new.detected_country_code    is distinct from old.detected_country_code or
       new.pricing_region           is distinct from old.pricing_region or
       new.pricing_region_source    is distinct from old.pricing_region_source or
       new.pricing_region_locked_at is distinct from old.pricing_region_locked_at or
       new.credit_balance           is distinct from old.credit_balance
     )
  then
    raise exception 'Direct modification of protected profile columns is not allowed';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. TABLE: payments
-- ---------------------------------------------------------------------------

-- One-time credit-pack purchases, made through Razorpay Orders — a different
-- Razorpay object and a different webhook vocabulary from the recurring
-- Subscriptions tracked in public.subscriptions. The two are kept in separate
-- tables rather than unified because they share almost no lifecycle.
--
-- Created BEFORE credit_ledger, which carries an FK to it.
create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references public.profiles(id) on delete cascade,
  provider            billing_provider not null default 'razorpay',
  -- Razorpay's order_xxx. Nullable-but-unique: the row may be written before
  -- the order is created, and two rows must never claim the same order.
  provider_order_id   text unique,
  -- Razorpay's pay_xxx. Null until the payment is actually attempted.
  provider_payment_id text unique,
  -- What was bought, e.g. 'credit_pack_25'. Text rather than an enum: the pack
  -- catalogue is expected to churn, and a stale historical value must remain
  -- readable after a pack is retired.
  purpose             text not null,
  -- Credits this purchase grants on capture. The ledger, not this column, is
  -- what actually moves the balance.
  credits_granted     int not null default 0,
  -- Paise/cents. Integer minor units, never a float. This is the amount this
  -- specific customer actually paid, and is the audit record — plan_prices is
  -- overwritten in place and cannot serve that purpose.
  amount_minor        int not null,
  currency            text not null,
  -- 'created' | 'captured' | 'failed' | 'refunded'.
  status              text not null,
  -- Whether the Razorpay signature over this payment was verified server-side.
  -- Never trust a 'captured' row whose signature was not verified.
  signature_verified  boolean not null default false,
  captured_at         timestamptz,
  created_at          timestamptz not null default now()
);

-- "This profile's payment history, most recent first."
create index payments_profile_id_created_at_idx
  on public.payments (profile_id, created_at desc);

alter table public.payments enable row level security;

-- Read-only for clients. All writes happen server-side via the service role,
-- because they follow signature verification the client cannot perform.
create policy payments_select_own on public.payments
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 7. TABLE: credit_ledger
-- ---------------------------------------------------------------------------

-- Append-only record of every credit movement: +25 on a pack purchase, -1 on
-- consumption, +1 on refund. profiles.credit_balance is the running total;
-- this is the history that total must be reconcilable against, so rows are
-- never updated or deleted.
--
-- Created AFTER payments, which it references.
create table public.credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  -- Signed change in credits. Never zero in practice; not constrained, so an
  -- 'adjustment' correction can be recorded however support needs it.
  delta           int not null,
  reason          credit_reason not null,
  -- The purchase that produced this grant; set when reason='pack_purchase'.
  -- ON DELETE SET NULL, not CASCADE: if a payment row is ever removed, the
  -- ledger row must survive without its reference rather than vanish. This
  -- ledger must never lose history.
  ref_payment_id  uuid references public.payments(id) on delete set null,
  -- The analysis this credit was spent on or refunded for; set on a
  -- best-effort basis when reason='analysis' or 'refund'. Legitimately stays
  -- NULL in the common case: the consume-a-credit decision happens before the
  -- analyses row exists — the same ordering constraint quota consumption
  -- already lives with. ON DELETE SET NULL for the same
  -- never-lose-history reason as ref_payment_id.
  ref_analysis_id uuid references public.analyses(id) on delete set null,
  -- Balance snapshot immediately after applying delta, for reconciliation
  -- against profiles.credit_balance without replaying the whole ledger.
  balance_after   int not null,
  created_at      timestamptz not null default now()
);

-- "This profile's credit history, most recent first."
create index credit_ledger_profile_id_created_at_idx
  on public.credit_ledger (profile_id, created_at desc);

alter table public.credit_ledger enable row level security;

-- Read-only for clients, matching usage_counters exactly: writes must be atomic
-- with the profiles.credit_balance update, so they happen only in a future
-- server-side function using the service role.
create policy credit_ledger_select_own on public.credit_ledger
  for select
  using (profile_id = auth.uid());
