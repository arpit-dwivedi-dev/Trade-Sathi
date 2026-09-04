-- Fundamentals AI analysis: a user-triggered run on the Fundamentals tab,
-- reading the InstrumentFundamentals payload rather than a chart. It reuses
-- the analyses table (Realtime, History, the stranded sweeper) so it needs its
-- own provenance value on analyses.source to stay distinguishable from a
-- chart read (different payload shape, no image, its own entitlement).
--
-- Alone in this file on purpose: alter type ... add value cannot run inside a
-- transaction block, and the Supabase CLI wraps each migration file in one.
alter type analysis_source add value if not exists 'fundamentals';
