-- Adds the credit_reason value the profile-survey credit grant will use.
--
-- Alone in this file on purpose: alter type ... add value cannot run inside a
-- transaction block, and the Supabase CLI wraps each migration file in one.
alter type credit_reason add value if not exists 'survey_completion';
