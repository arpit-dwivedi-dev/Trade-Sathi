-- Removes analyses.schema_version.
--
-- The column was added directly against the remote database by a migration
-- that never landed in this repo (remote 20260903100000, no local file), as
-- `text not null` with no default. Nothing in apps/ or packages/ ever writes
-- it, so every insert into `analyses` — manual upload, live analysis, and the
-- watchlist's Analyze Now / Brief Now — failed the not-null check and the
-- whole analysis pipeline was dead.
--
-- Dropped rather than defaulted: no reader and no writer exists for it, so a
-- default would only preserve a column that means nothing.
alter table public.analyses
  drop column if exists schema_version;
