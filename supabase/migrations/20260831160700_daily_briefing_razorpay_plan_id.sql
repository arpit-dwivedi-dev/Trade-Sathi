-- Wires the real Razorpay plan object to the Daily Briefing SKU's price row,
-- created manually in the Razorpay dashboard for ₹299/month
-- (see 20260831160600_daily_briefing_real_price.sql for the amount_minor).
update public.plan_prices
set razorpay_plan_id = 'plan_TWPsTwVluI6mwi'
where plan_id = (select id from public.plans where key = 'daily_briefing_monthly')
  and region = 'IN'
  and currency = 'INR';
