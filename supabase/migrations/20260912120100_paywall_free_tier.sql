-- TradeSathi — hard paywall: retire the free tier's allowance.
--
-- The free plan ROW is not deleted. handle_new_user() assigns it to every
-- signup and profiles.plan_id is NOT NULL, so the row must keep existing; new
-- signups land on it and are simply not granted anything.
--
-- Setting analyses_per_month = 0 makes the paywall fall out of the existing
-- entitlement logic with no entitlement-code change at all:
--   check_and_increment_usage → 0 >= 0 → false
--   → check_and_consume_entitlement falls through to the credit branch
--   → credit_balance 0 → 'denied'.
-- A new signup therefore cannot run an analysis until they buy the entry
-- pass, a subscription, or redeem a promo code — the three paid/free-intent
-- paths into the product.
--
-- The rename to 'Inactive' is the UI half of the same change: no surface may
-- read as a free tier any more.

-- 1. Grandfather existing free-plan users, BEFORE the allowance is zeroed.
--
-- Everyone currently sitting on 'free' has a working allowance today; taking
-- it away outright would lock them out mid-month. Instead the CURRENT monthly
-- allowance is converted into one-time credits: the same number of analyses
-- they could still run, but via the credit balance so the paywall applies to
-- them only once those are spent.
--
-- The amount is read from the plans row at run time rather than hardcoded, so
-- whatever the free allowance actually is today (3) is what is granted — the
-- migration is correct even if an earlier migration changed it.
--
-- Writing profiles.credit_balance directly would be blocked by Trigger C
-- (protect_profile_columns) except for the service role — and migrations run
-- as the postgres role, not service_role. The escape hatch Trigger C exists
-- for is the trusted-sync flag (the same one handle_user_email_update sets
-- for exactly one UPDATE); set for the length of this transaction, it lets
-- this one trusted migration write the protected column and nothing else.
select set_config('tradesathi.trusted_profile_sync', 'on', true);

-- A WITH clause only scopes the single statement it precedes in Postgres —
-- it does not persist across the `;` boundary into the next statement — so
-- free_plan is redefined identically for each of the two statements below
-- rather than shared.
with free_plan as (
  select id, analyses_per_month
  from public.plans
  where key = 'free'
)
insert into public.credit_ledger (profile_id, delta, reason, balance_after)
select pr.id, fp.analyses_per_month, 'adjustment', pr.credit_balance + fp.analyses_per_month
from public.profiles pr
join free_plan fp on fp.id = pr.plan_id;

with free_plan as (
  select id, analyses_per_month
  from public.plans
  where key = 'free'
)
update public.profiles pr
set credit_balance = pr.credit_balance + fp.analyses_per_month
from free_plan fp
where pr.plan_id = fp.id;

-- 2. Zero the allowance and retire the name. After this point the row is an
-- inert placeholder that satisfies the NOT NULL / handle_new_user contract.
update public.plans
set analyses_per_month = 0,
    name = 'Inactive'
where key = 'free';

-- Free's price rows (IN and GLOBAL, both amount 0) are left active on
-- purpose: plan_prices must resolve a price for every plan in every region —
-- see 20260830230000, "the future pricing lookup has no special case for it".
-- A zero price is no longer shown as a purchasable tier anywhere in the UI.
