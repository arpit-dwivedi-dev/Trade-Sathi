-- Lets a user delete their own past analyses from the History list. Deletes
-- were client-only reads until now (see analyses_select_own); this adds the
-- matching delete policy so the client SDK can remove a row without a backend
-- endpoint, same read/delete-your-own-data pattern already used elsewhere.
--
-- analysis_patterns rows cascade via their `on delete cascade` foreign key
-- (see 20260829150147_init.sql), so no separate policy is needed there. The
-- chart-images object for a deleted row is left in storage — the bucket has
-- no client delete policy by design (service-role-only writes), and cleaning
-- up orphaned images is a job for later, not part of this change.
create policy analyses_delete_own on public.analyses
  for delete
  to authenticated
  using (profile_id = auth.uid());
