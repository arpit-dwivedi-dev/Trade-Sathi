-- Daily Briefing: the plan row for the new automation SKU, plus its own
-- configurable monthly-allowance table.
--
-- This is a genuinely separate product from the manual-analysis plans
-- (free/starter_monthly/pro_monthly/pro_annual): a user can hold a manual
-- plan AND this add-on independently, billed through the same
-- Razorpay/subscriptions infrastructure but never sharing profiles.plan_id
-- or usage_counters with the manual flow. See
-- 20260831160300_daily_briefing_schema.sql for the counters/log tables and
-- 20260831160400_daily_briefing_entitlement_functions.sql for how this plan's
-- entitlement is actually checked (via public.subscriptions, never
-- profiles.plan_id).
--
-- plans.analyses_per_month is part of the manual-analysis contract
-- (check_and_increment_usage joins profiles.plan_id -> plans.analyses_per_month).
-- This row must not be read through that path, so it gets an intentionally
-- inert value (0) there; the real, independently configurable allowance lives
-- in daily_briefing_entitlements below.
insert into public.plans (key, name, analyses_per_month, price_inr_paise, is_active)
values ('daily_briefing_monthly', 'Daily Briefing', 0, 0, true);

-- Placeholder price. amount_minor is deliberately 0 / is_active false until a
-- real ₹ price and a real Razorpay plan object exist — see the flagged open
-- item in the implementation plan. Flip is_active and set the real
-- amount_minor + razorpay_plan_id once those exist; do not derive a price
-- here.
insert into public.plan_prices (plan_id, region, currency, amount_minor, razorpay_plan_id, is_active)
select id, 'IN', 'INR', 0, null, false
from public.plans
where key = 'daily_briefing_monthly';

-- ---------------------------------------------------------------------------
-- TABLE: daily_briefing_entitlements
-- ---------------------------------------------------------------------------

-- The configurable monthly automated-analysis allowance per Daily Briefing
-- plan tier. Deliberately its own tiny table rather than reusing
-- plans.analyses_per_month: that column is load-bearing for the manual
-- entitlement RPC (check_and_increment_usage) and must not be repurposed for
-- a second, unrelated meaning. This table exists so a future second tier
-- (e.g. a higher-allowance add-on) is a new row here, not a schema change.
create table public.daily_briefing_entitlements (
  plan_key             plan_key primary key references public.plans(key),
  monthly_auto_analyses int not null check (monthly_auto_analyses > 0),
  created_at           timestamptz not null default now()
);

insert into public.daily_briefing_entitlements (plan_key, monthly_auto_analyses)
values ('daily_briefing_monthly', 30);

alter table public.daily_briefing_entitlements enable row level security;

-- Read-only reference data, same shape as plans itself.
create policy daily_briefing_entitlements_select_all on public.daily_briefing_entitlements
  for select
  to anon, authenticated
  using (true);

revoke all on public.daily_briefing_entitlements from anon, authenticated;
grant select on public.daily_briefing_entitlements to anon, authenticated;
