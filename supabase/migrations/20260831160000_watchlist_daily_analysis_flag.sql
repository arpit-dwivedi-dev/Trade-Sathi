-- Daily Briefing: per-item opt-in flag.
--
-- A user can keep a symbol on their watchlist without receiving automated
-- daily analysis for it — this column is that independent toggle. Default
-- false so existing rows (and newly added ones) are opt-in, not opt-out.
alter table public.watchlist_items
  add column enabled_for_daily_analysis boolean not null default false;

-- The existing migration deliberately has no UPDATE policy ("a user removes
-- and re-adds a symbol rather than editing a watch entry in place"). That
-- policy predates this column and does not fit it: forcing a delete+re-add
-- just to flip a daily-analysis toggle would also throw away created_at and
-- risk racing the unique(profile_id, instrument_id) constraint on re-insert.
--
-- Rather than opening full row UPDATE (which would let a client rewrite
-- profile_id/instrument_id/symbol on someone else's or its own row in ways
-- the schema doesn't intend), grant UPDATE on exactly this one column and add
-- an UPDATE policy scoped to the owner. Column-level privilege plus row-level
-- policy together mean: an authenticated user may update
-- enabled_for_daily_analysis on their own rows, and nothing else, ever.
create policy watchlist_update_own_daily_flag on public.watchlist_items
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

grant update (enabled_for_daily_analysis) on public.watchlist_items to authenticated;
