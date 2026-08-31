-- Per-item analysis settings: how much chart history to analyse, and at what
-- IST hour the scheduled run for that symbol should happen.
--
-- Both were previously fixed for everyone — CANDLE_LOOKBACK_DAYS = 90 in
-- daily-briefing.service.ts and a single DAILY_BRIEFING_RUN_HOUR_IST env var.
-- The defaults below keep existing rows behaving exactly as they do today.

alter table public.watchlist_items
  -- Calendar days of daily candles to fetch and render for this symbol.
  -- Bounded: below ~10 days there are too few candles to read a pattern from,
  -- and above a year the chart stops being legible at the renderer's fixed
  -- width. 90 is the value the pipeline has always used. (The lower bound is
  -- relaxed to 1 in 20260831170200, once short windows started being drawn
  -- from intraday candles.)
  add column analysis_lookback_days int not null default 90
    constraint watchlist_items_analysis_lookback_days_range
    check (analysis_lookback_days between 10 and 365),

  -- IST hour (0-23) at which this symbol's scheduled analysis runs. NULL means
  -- "follow the deployment default" (DAILY_BRIEFING_RUN_HOUR_IST) rather than
  -- a hardcoded number, so changing that env var keeps moving unconfigured
  -- rows the way it does today.
  add column scheduled_hour_ist smallint
    constraint watchlist_items_scheduled_hour_ist_range
    check (scheduled_hour_ist between 0 and 23);

-- Column-scoped, exactly as with enabled_for_daily_analysis (see
-- 20260831160000_watchlist_daily_analysis_flag.sql): the owner-scoped UPDATE
-- policy added there already covers these rows, so only the privilege needs
-- extending. profile_id/instrument_id/symbol stay non-writable by clients.
grant update (analysis_lookback_days, scheduled_hour_ist)
  on public.watchlist_items to authenticated;

-- ---------------------------------------------------------------------------
-- daily_briefing_log: one row per user per date PER RUN HOUR
-- ---------------------------------------------------------------------------
-- With per-symbol hours a user can legitimately be processed more than once a
-- calendar day (say RELIANCE at 08:00 IST and TCS at 18:00 IST), each run
-- covering a different set of symbols. The old unique (profile_id,
-- briefing_date) would collapse those into one, silently dropping every run
-- after the first. Widening the key to include the run hour keeps the same
-- idempotency guarantee at the granularity work is now actually scheduled at:
-- a given (user, date, hour) briefing still runs at most once.
alter table public.daily_briefing_log
  add column run_hour_ist smallint not null default 0
    constraint daily_briefing_log_run_hour_ist_range
    check (run_hour_ist between 0 and 23);

alter table public.daily_briefing_log
  drop constraint daily_briefing_log_profile_id_briefing_date_key;

alter table public.daily_briefing_log
  add constraint daily_briefing_log_profile_id_briefing_date_run_hour_key
    unique (profile_id, briefing_date, run_hour_ist);
