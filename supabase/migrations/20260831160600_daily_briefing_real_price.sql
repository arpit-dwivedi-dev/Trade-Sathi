-- Sets the real launch price for the Daily Briefing SKU: ₹299/month
-- (29900 paise). razorpay_plan_id stays null until a matching Razorpay plan
-- object is created in the dashboard/API — the webhook path
-- (apply_subscription_webhook) resolves plans by plan_id, not
-- razorpay_plan_id, so this is safe to activate ahead of that.
update public.plan_prices
set amount_minor = 29900,
    is_active = true
where plan_id = (select id from public.plans where key = 'daily_briefing_monthly')
  and region = 'IN'
  and currency = 'INR';
