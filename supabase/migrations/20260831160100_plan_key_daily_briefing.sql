-- ---------------------------------------------------------------------------
-- Add 'daily_briefing_monthly' to the plan_key enum.
--
-- Split into its own migration for the same reason as
-- 20260830231500_plan_key_starter_monthly.sql: a value added by
-- ALTER TYPE ... ADD VALUE cannot be used later in the same transaction, and
-- each migration file is one transaction.
-- ---------------------------------------------------------------------------
alter type plan_key add value if not exists 'daily_briefing_monthly';
