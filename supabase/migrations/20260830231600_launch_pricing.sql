-- ---------------------------------------------------------------------------
-- Real launch pricing.
--
-- Replaces the ₹1 test price on pro_monthly (set by 20260830224500 against the
-- test plan object plan_TVkjBkDomDZToS) with the live ₹399 plan, and adds the
-- Starter tier at ₹149. Both plan ids come from the Razorpay dashboard.
--
-- Values are written explicitly rather than derived from what is currently in
-- the table, so the outcome does not depend on which of the earlier test-price
-- migrations happen to have been applied.
--
-- Scope: plans and plan_prices only. usage_counters, subscriptions and
-- webhook_events are deliberately untouched — an existing subscriber stays on
-- the Razorpay plan object and amount recorded on their own subscriptions row
-- at purchase time. This migration changes only what NEW signups are shown and
-- charged.
--
-- Requires 'starter_monthly' to already exist on the plan_key enum
-- (20260830231500) and public.plan_prices to already exist
-- (20260830230000_region_pricing_and_credits).
--
-- Money stays in integer minor units: ₹399 = 39900 paise, ₹149 = 14900 paise.
-- ---------------------------------------------------------------------------

-- 1. pro_monthly: ₹1 test → ₹399 live.
--
-- plans.price_inr_paise is what billing.service.ts copies into
-- subscriptions.amount_minor, so it must move in lockstep with the plan id.
update public.plans
   set price_inr_paise  = 39900,
       razorpay_plan_id = 'plan_TVzh1JTHfw0gCM'
 where key = 'pro_monthly';

-- 2. The new Starter tier.
insert into public.plans (key, name, analyses_per_month, price_inr_paise, razorpay_plan_id, is_active)
values ('starter_monthly', 'Starter Monthly', 30, 14900, 'plan_TVzgCH7sRdI4jI', true);

-- 3. plan_prices — the IN/INR region rows, kept in sync with plans.
--
-- The free rows and every GLOBAL row are left alone: free is priced at 0 in
-- both regions, and no GLOBAL paid row exists yet (that Razorpay plan object
-- has not been created).
update public.plan_prices
   set amount_minor     = 39900,
       razorpay_plan_id = 'plan_TVzh1JTHfw0gCM'
 where plan_id = (select id from public.plans where key = 'pro_monthly')
   and region  = 'IN'
   and currency = 'INR';

insert into public.plan_prices (plan_id, region, currency, amount_minor, razorpay_plan_id)
values (
  (select id from public.plans where key = 'starter_monthly'),
  'IN',
  'INR',
  14900,
  'plan_TVzgCH7sRdI4jI'
);
