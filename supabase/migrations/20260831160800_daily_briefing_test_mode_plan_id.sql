-- The plan wired in 20260831160700 (plan_TWPsTwVluI6mwi) was created in the
-- Razorpay dashboard's Live mode, but this project currently runs on
-- RAZORPAY_KEY_ID/SECRET test keys, so checkout failed with a generic
-- "Payment Failed" error. Replaces it with a Test-mode plan
-- (plan_TWQfnGOYcAoNiS, same ₹299/month) created via the Razorpay API.
update public.plan_prices
set razorpay_plan_id = 'plan_TWQfnGOYcAoNiS'
where plan_id = (select id from public.plans where key = 'daily_briefing_monthly')
  and region = 'IN'
  and currency = 'INR';
