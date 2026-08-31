-- Allow chart windows shorter than 10 days.
--
-- 20260831170000 bounded the window at 10 days because a shorter one has too
-- few DAILY candles to read anything from — one candle for a day, about five
-- for a week. Short windows are now drawn from intraday candles instead (see
-- candleSpecFor in daily-briefing.service.ts: 5-minute candles up to a day,
-- 30-minute up to a week), so "1 day" and "1 week" are real charts and the
-- old lower bound is the only thing standing in their way.
--
-- Written as drop-then-add rather than an edit to the original migration,
-- which has already been applied.
alter table public.watchlist_items
  drop constraint if exists watchlist_items_analysis_lookback_days_range;

alter table public.watchlist_items
  add constraint watchlist_items_analysis_lookback_days_range
  check (analysis_lookback_days between 1 and 365);
