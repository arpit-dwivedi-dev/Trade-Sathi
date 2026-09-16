-- ChartAnalyzer — GLOBAL (USD) price rows for the two manual tiers.
--
-- India prices are already live and are deliberately NOT touched here. This
-- adds the USD counterpart rows for starter_monthly ($9) and pro_monthly
-- ($19) so the region-aware purchase path (billing.service.ts reads
-- plan_prices by the caller's pricing_region) and the public pricing page
-- have something to resolve for a GLOBAL caller.
--
-- The rows are seeded is_active = false with razorpay_plan_id = null, exactly
-- as 20260831160200_daily_briefing_plan_seed.sql seeded the briefing's IN row
-- before its real price existed: Razorpay plan objects are currency-bound and
-- must be created manually in the dashboard once international payments are
-- activated on the account — code cannot create them, and publishing a price
-- that cannot actually be charged is worse than showing nothing. While these
-- rows are inactive, a GLOBAL caller's purchase attempt correctly fails with
-- 'plan_unavailable'.
--
-- Money is integer minor units: $9 = 900 cents, $19 = 1900 cents.

-- Exactly one row per (plan, region) is guaranteed by
-- plan_prices_plan_id_region_key, so a re-run of this seed against an already
-- populated table must not create a duplicate: ON CONFLICT DO NOTHING keeps
-- the migration idempotent while the rows are still placeholders.
insert into public.plan_prices (plan_id, region, currency, amount_minor, razorpay_plan_id, is_active)
select id, 'GLOBAL', 'USD', 900, null, false
from public.plans
where key = 'starter_monthly'
on conflict (plan_id, region) do nothing;

insert into public.plan_prices (plan_id, region, currency, amount_minor, razorpay_plan_id, is_active)
select id, 'GLOBAL', 'USD', 1900, null, false
from public.plans
where key = 'pro_monthly'
on conflict (plan_id, region) do nothing;

-- ---------------------------------------------------------------------------
-- FOLLOW-UP STUB — do NOT run as part of this migration.
--
-- Once the two USD Razorpay plan objects exist (created in the Razorpay
-- dashboard in the SAME mode as the configured RAZORPAY_KEY_ID — the
-- 20260831160800 incident was a Live-mode plan id on test keys), put the
-- content below into a NEW migration file with a new timestamp and the real
-- plan ids, and apply that. Never edit or re-apply this file: it is already
-- recorded in the migration history once applied, and edits to an applied
-- migration do not run.
--
-- update public.plan_prices
--    set razorpay_plan_id = 'plan_<starter USD id>',
--        is_active = true
--  where plan_id = (select id from public.plans where key = 'starter_monthly')
--    and region = 'GLOBAL';
--
-- update public.plan_prices
--    set razorpay_plan_id = 'plan_<pro USD id>',
--        is_active = true
--  where plan_id = (select id from public.plans where key = 'pro_monthly')
--    and region = 'GLOBAL';
-- ---------------------------------------------------------------------------
