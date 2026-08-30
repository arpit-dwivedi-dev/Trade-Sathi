-- ---------------------------------------------------------------------------
-- Align pro_monthly's stored price with its Razorpay plan object.
--
-- 20260830223000 pointed pro_monthly at plan_TVkjBkDomDZToS, which is a ₹1
-- plan, but plans.price_inr_paise still held the old 24900 (₹249). The local
-- value is what billing.service.ts writes into subscriptions.amount_minor, so
-- leaving it stale would record every subscription at the wrong amount.
--
-- Money stays in integer minor units: ₹1 = 100 paise.
-- ---------------------------------------------------------------------------
update public.plans
   set price_inr_paise = 100
 where key = 'pro_monthly';
