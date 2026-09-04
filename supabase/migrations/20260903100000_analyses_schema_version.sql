-- Reconstructed from the remote database, not authored here.
--
-- This version was applied directly against the remote project and its file
-- never landed in the repo, which left the migration history unpushable
-- ("Remote migration versions not found in local migrations directory") and
-- the schema unreproducible from source. The statement below is what
-- `supabase db diff --linked` reported as the drift, so a shadow database
-- built from these migrations now matches the remote one.
--
-- Already applied remotely, so this is a no-op there; it exists to make the
-- history complete. The column is dropped again immediately after — see
-- 20260904120000_drop_analyses_schema_version.sql for why.
alter table public.analyses
  add column schema_version text not null;
