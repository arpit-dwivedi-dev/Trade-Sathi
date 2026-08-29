-- ChartAnalyzer — private storage bucket for uploaded chart images.

-- ---------------------------------------------------------------------------
-- 1. BUCKET: chart-images
-- ---------------------------------------------------------------------------

-- Private bucket holding the raw chart screenshots submitted for analysis.
--
-- file_size_limit is a hard ceiling against abuse, not the expected size:
-- client-side compression should keep real uploads well under 1MB.
--
-- ON CONFLICT DO NOTHING keeps this migration idempotent if it is ever re-run
-- against a project where the bucket already exists.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chart-images',
  'chart-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. STORAGE RLS POLICIES
-- ---------------------------------------------------------------------------

-- Object path convention: every object in this bucket must be stored at
-- '{profile_id}/{filename}' — the first path segment is always the owning
-- user's profile id. The SELECT policy below depends on this. The backend is
-- responsible for uploading under this convention; it is not enforced here
-- because all writes go through the service role, which bypasses RLS.

-- Lets a user read back their own past chart images directly via the Supabase
-- client SDK, matching the read-your-own-data pattern used by the analyses and
-- usage_counters tables.
create policy chart_images_select_own on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'chart-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- There are deliberately NO INSERT, UPDATE or DELETE policies for the
-- authenticated or anon roles. This is intentional, not an oversight: matching
-- the analyses and usage_counters tables, every write to this bucket happens
-- server-side via the service role, because an upload may only occur after
-- quota checks, image-hash dedupe and cost tracking — all of which live in the
-- API layer. Do not "fix" this by adding a client upload policy.
