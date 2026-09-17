-- TradeSathi — map internal plans to their Razorpay plan objects.
--
-- Schema + data only. No application code reads this column yet.

-- ---------------------------------------------------------------------------
-- 1. COLUMN
-- ---------------------------------------------------------------------------

-- Razorpay's plan_xxx. Nullable: the free plan has no Razorpay plan object, and
-- never will — it is never charged, so there is nothing for Razorpay to bill
-- against. A NULL here means "this plan is not purchasable through Razorpay",
-- not "not yet configured".
alter table public.plans
  add column razorpay_plan_id text;

-- ---------------------------------------------------------------------------
-- 2. UNIQUENESS
-- ---------------------------------------------------------------------------

-- Two different internal plans must never point at the same Razorpay plan: that
-- would make a webhook carrying a plan_xxx ambiguous as to which entitlement to
-- grant. A partial index rather than a plain unique constraint because multiple
-- rows are legitimately NULL — and while Postgres treats NULLs as distinct
-- under a normal unique constraint anyway, stating WHERE ... IS NOT NULL makes
-- the intent explicit rather than dependent on that behavior.
create unique index plans_razorpay_plan_id_key
  on public.plans (razorpay_plan_id)
  where razorpay_plan_id is not null;

-- ---------------------------------------------------------------------------
-- 3. DATA
-- ---------------------------------------------------------------------------

-- The pro_monthly plan's Razorpay plan id. Replace the marker on the next line
-- with the quoted plan_xxx value, e.g.  set razorpay_plan_id = 'plan_ABC123'
--
-- Left as a bare comment, not a quoted dummy string, so that running this
-- migration unfilled is a syntax error rather than a silent write of a value
-- that would never match anything Razorpay sends.
update public.plans
   set razorpay_plan_id = 'plan_TVj2bmAG7VMyhF'
 where key = 'pro_monthly';

-- 'free' is intentionally left NULL and is not touched here.
