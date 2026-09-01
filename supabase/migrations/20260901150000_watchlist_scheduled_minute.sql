-- Adds minute granularity to the per-item scheduled run time. Previously a
-- watchlist item could only be scheduled on the hour (scheduled_hour_ist);
-- this widens that to hour+minute so a user can pick e.g. 08:15 IST rather
-- than only 08:00 or 09:00.

alter table public.watchlist_items
  -- Minute (0-59) within scheduled_hour_ist. NULL alongside a NULL
  -- scheduled_hour_ist means "follow the deployment default", same as today;
  -- a NULL minute with a non-NULL hour means "on the hour", so existing rows
  -- (which all have scheduled_minute_ist NULL) keep behaving exactly as they
  -- do today without a backfill.
  add column scheduled_minute_ist smallint
    constraint watchlist_items_scheduled_minute_ist_range
    check (scheduled_minute_ist between 0 and 59);

grant update (scheduled_minute_ist)
  on public.watchlist_items to authenticated;

-- ---------------------------------------------------------------------------
-- daily_briefing_log: one row per user per date PER RUN HOUR+MINUTE
-- ---------------------------------------------------------------------------
-- Mirrors the hour widening in 20260831170000_watchlist_analysis_settings.sql:
-- with per-symbol minutes, a user can now legitimately be processed more than
-- once within the same hour (say RELIANCE at 08:00 IST and TCS at 08:15 IST).
-- The old unique (profile_id, briefing_date, run_hour_ist) would collapse
-- those into one, silently dropping every run after the first in that hour.
alter table public.daily_briefing_log
  add column run_minute_ist smallint not null default 0
    constraint daily_briefing_log_run_minute_ist_range
    check (run_minute_ist between 0 and 59);

alter table public.daily_briefing_log
  drop constraint daily_briefing_log_profile_id_briefing_date_run_hour_key;

alter table public.daily_briefing_log
  add constraint daily_briefing_log_profile_id_briefing_date_run_hour_run_minute_key
    unique (profile_id, briefing_date, run_hour_ist, run_minute_ist);
