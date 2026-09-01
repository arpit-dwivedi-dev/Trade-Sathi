-- Live chart analysis: a user-triggered run on any instrument from the live
-- chart view, not tied to a watchlist entry. It reuses the same generated-chart
-- pipeline as the daily briefing, so it needs its own provenance value on
-- analyses.source to stay distinguishable from scheduled watchlist work
-- (different quota, different retention story, different place in the UI).
--
-- Alone in this file on purpose: alter type ... add value cannot run inside a
-- transaction block, and the Supabase CLI wraps each migration file in one.
alter type analysis_source add value if not exists 'live';
