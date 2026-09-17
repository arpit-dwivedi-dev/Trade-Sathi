-- TradeSathi — unified credit billing, part 2: new tables and columns.
--
-- One balance (profiles.credit_balance, already existed), one ledger, feature
-- cost and region price as pure config data. See the plan this batch
-- implements: feature_credit_costs / credit_pricing_regions are read by the
-- API, never hardcoded in service logic — adding a future paid feature or
-- region is a data insert, not a code change.

-- ---------------------------------------------------------------------------
-- 1. TABLE: feature_credit_costs
-- ---------------------------------------------------------------------------

-- feature_key is plain text, not an enum: enum values require a migration to
-- add, which is exactly the "modifying feature logic to change a cost"
-- friction this table exists to remove. The API validates feature_key
-- against a small shared constant list (packages/shared) before calling
-- consume_credits, so an unknown key is a programming error caught in
-- application code, not something this table needs to constrain.
create table public.feature_credit_costs (
  feature_key text primary key,
  credits     int not null check (credits > 0),
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.feature_credit_costs enable row level security;

-- Same pattern as the old plans table: readable by anon/authenticated so a
-- pricing/cost display can render before login, writable only by migrations
-- or a future admin tool via the service role.
create policy feature_credit_costs_select_active on public.feature_credit_costs
  for select
  to anon, authenticated
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- 2. TABLE: credit_pricing_regions
-- ---------------------------------------------------------------------------

-- Replaces plan_prices. One row per region (not per plan × region, since
-- there are no plans anymore) — the price of a credit and the purchase rules
-- around it.
create table public.credit_pricing_regions (
  region                  pricing_region primary key,
  -- ISO 4217. Not derived from region in code, same reasoning plan_prices
  -- carried: a region's billing currency is a business decision.
  currency                text not null,
  -- Paise/cents per credit. Integer minor unit, never a float.
  price_per_credit_minor  int not null check (price_per_credit_minor > 0),
  min_purchase_credits    int not null check (min_purchase_credits > 0),
  -- Pre-filled quick-select amounts for the buy-credits UI, in minor units —
  -- display sugar only, not distinct SKUs. Any quantity at or above
  -- min_purchase_credits can still be purchased directly.
  quick_amounts_minor     int[] not null,
  is_active               boolean not null default true,
  updated_at              timestamptz not null default now()
);

alter table public.credit_pricing_regions enable row level security;

create policy credit_pricing_regions_select_active on public.credit_pricing_regions
  for select
  to anon, authenticated
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- 3. ENUM: credit_reason (recreated with the unified reason set)
-- ---------------------------------------------------------------------------

create type credit_reason as enum (
  'purchase',            -- a credit-pack order was captured
  'feature_consumption', -- spent on chart_analysis / daily_briefing_run / fundamental_analysis / …
  'refund',              -- compensating grant for a consumption that produced no usable result
  'promo_credit',        -- a promo code's free_credits component was redeemed
  'admin_adjustment'     -- manual support/ops correction
);

-- ---------------------------------------------------------------------------
-- 4. TABLE: promo_codes (recreated — free credits, a discount, or both)
-- ---------------------------------------------------------------------------

create table public.promo_codes (
  id                        uuid primary key default gen_random_uuid(),
  -- Stored as entered; compared case-insensitively via the unique index
  -- below, same convention as the old promo_codes.
  code                      text not null,
  free_credits              int check (free_credits > 0),
  discount_percent          numeric(5,2) check (discount_percent > 0 and discount_percent <= 100),
  discount_fixed_minor      int check (discount_fixed_minor > 0),
  -- Caps a percent discount's absolute value; meaningless (and left null) for
  -- a fixed discount.
  max_discount_amount_minor int check (max_discount_amount_minor > 0),
  -- Order must be at least this large (pre-discount) for a discount to apply.
  min_purchase_amount_minor int check (min_purchase_amount_minor > 0),
  -- null = unlimited total redemptions across all accounts.
  max_redemptions           int check (max_redemptions > 0),
  redemption_count          int not null default 0 check (redemption_count >= 0),
  per_user_limit            int not null default 1 check (per_user_limit > 0),
  -- null/empty = eligible in every region.
  region_eligibility        pricing_region[],
  starts_at                 timestamptz,
  -- Nullable, unlike the old promo_codes: a referral/beta/partnership code
  -- may legitimately never expire. A code meant to run for a limited window
  -- still sets this explicitly.
  expires_at                timestamptz,
  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  -- A code must do at least one of the two things it exists to do.
  constraint promo_codes_has_an_effect check (
    free_credits is not null or discount_percent is not null or discount_fixed_minor is not null
  ),
  -- A discount is either a percentage or a fixed amount, never both at once
  -- (max_discount_amount_minor is the percent-only cap, kept as a separate
  -- nullable column rather than folded into this check).
  constraint promo_codes_one_discount_mode check (
    not (discount_percent is not null and discount_fixed_minor is not null)
  )
);

create unique index promo_codes_code_ci_idx on public.promo_codes (upper(code));

alter table public.promo_codes enable row level security;

-- No client policies, same reasoning as before: a leaked code list is a
-- free-credit/discount mint. Redemption goes through
-- redeem_promo_code_credits (free credits) or the purchase-order flow
-- (discount); both run server-side via the service role.

-- ---------------------------------------------------------------------------
-- 5. TABLE: promo_redemptions (recreated — no hard per-account unique, since
--    per_user_limit can now be > 1)
-- ---------------------------------------------------------------------------

create table public.promo_redemptions (
  id                     uuid primary key default gen_random_uuid(),
  code_id                uuid not null references public.promo_codes(id) on delete restrict,
  profile_id             uuid not null references public.profiles(id) on delete cascade,
  redemption_type        text not null check (redemption_type in ('free_credits', 'discount')),
  credits_granted        int,
  discount_applied_minor int,
  -- Set for a 'discount' redemption: the order it discounted. Null for
  -- 'free_credits' (no purchase involved).
  ref_payment_id         uuid references public.payments(id) on delete set null,
  created_at             timestamptz not null default now()
);

-- Per-account/per-type usage is counted from these rows under a row lock on
-- promo_codes at redemption time (see redeem_promo_code_credits and
-- apply_credit_purchase in the next migration) rather than enforced by a
-- unique constraint, since per_user_limit is configurable and can exceed 1.
create index promo_redemptions_code_id_profile_id_idx
  on public.promo_redemptions (code_id, profile_id);

alter table public.promo_redemptions enable row level security;

-- No client policies: same as before, redemption is server-side only.

-- ---------------------------------------------------------------------------
-- 6. TABLE: credit_ledger (recreated — single unified ledger)
-- ---------------------------------------------------------------------------

create table public.credit_ledger (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  delta             int not null,
  reason            credit_reason not null,
  -- Set for feature_consumption/refund; identifies which feature moved the
  -- balance. Not a FK to feature_credit_costs — a historical row must stay
  -- readable even if that feature's cost row is later deactivated/renamed.
  feature_key       text,
  ref_payment_id    uuid references public.payments(id) on delete set null,
  ref_analysis_id   uuid references public.analyses(id) on delete set null,
  ref_promo_code_id uuid references public.promo_codes(id) on delete set null,
  -- Balance snapshot immediately after applying delta, for reconciliation
  -- without replaying the whole ledger.
  balance_after     int not null,
  -- Free-text reason for an admin_adjustment; null otherwise.
  note              text,
  created_at        timestamptz not null default now()
);

create index credit_ledger_profile_id_created_at_idx
  on public.credit_ledger (profile_id, created_at desc);

alter table public.credit_ledger enable row level security;

create policy credit_ledger_select_own on public.credit_ledger
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 7. TABLE: payments — flexible quantity + discount columns
-- ---------------------------------------------------------------------------

-- Existing rows are pre-launch test orders (no real subscribers yet,
-- confirmed with the product owner — this whole batch is a clean cutover,
-- not a data migration) from a pack catalogue that no longer exists. There
-- is nothing to backfill credits_purchased/base_amount_minor from that would
-- be meaningful, so they're cleared rather than carried forward with made-up
-- values.
delete from public.payments;

-- purpose/credits_granted were fixed-pack concepts (a purchase always bought
-- one of a small set of named packs). Quantity is now chosen by the buyer at
-- checkout time, so the pack name is gone and the credit count purchased is
-- its own column instead of implied by which pack.
alter table public.payments drop column if exists purpose;
alter table public.payments drop column if exists credits_granted;

alter table public.payments
  add column credits_purchased int not null default 0 check (credits_purchased > 0),
  -- Pre-discount price at the region's current rate.
  add column base_amount_minor int not null default 0,
  -- 0 when no promo code was applied. amount_minor (pre-existing column) is
  -- base_amount_minor - discount_minor: what Razorpay actually charged.
  add column discount_minor int not null default 0,
  add column promo_code_id uuid references public.promo_codes(id) on delete set null;

alter table public.payments alter column credits_purchased drop default;
alter table public.payments alter column base_amount_minor drop default;

-- ---------------------------------------------------------------------------
-- 8. PROFILES — backstop against a negative balance, and the trigger update
-- ---------------------------------------------------------------------------

alter table public.profiles
  add constraint profiles_credit_balance_non_negative check (credit_balance >= 0);

-- CREATE OR REPLACE of the function only; the trigger itself (defined in the
-- init migration) is untouched and keeps pointing at this same function.
-- plan_id and daily_briefing_credit_balance are gone (dropped in the previous
-- migration); credit_balance is still the one protected balance column.
-- Everything else — SECURITY INVOKER, the trusted-sync flag, search_path =
-- '' — is carried over unchanged. See the init migration for the reasoning.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'service_role'
     and coalesce(current_setting('tradesathi.trusted_profile_sync', true), 'off') <> 'on'
     and (
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
