-- ---------------------------------------------------------------------------
-- Point pro_monthly at a new Razorpay plan object.
--
-- The prior id (plan_TVj2bmAG7VMyhF, set in 20260830210032) is replaced by
-- plan_TVkjBkDomDZToS. The earlier migration is left untouched: it is already
-- applied, so editing it in place would not change the deployed database.
--
-- plans.razorpay_plan_id has a unique index, so the old value must not remain
-- on any other row; nothing else sets it today, but the update is scoped to
-- pro_monthly regardless.
-- ---------------------------------------------------------------------------
update public.plans
   set razorpay_plan_id = 'plan_TVkjBkDomDZToS'
 where key = 'pro_monthly';
