-- TradeSathi — remove the survey's free-credit grant.
--
-- submit_survey_response() (20260902130100) granted 1 analysis credit on
-- first completion of each survey. With the hard paywall in place
-- (20260912120100), that grant is a bypass: sign up → answer the survey →
-- run one analysis for free, with no purchase or promo code involved. Flagged
-- to the user as Step 7 of the paywall work; they chose to remove it rather
-- than keep it as an intentional free taste.
--
-- The function is CREATE OR REPLACEd rather than editing 20260902130100
-- directly — that migration is already applied, and CLAUDE.md's migration
-- rule is never to edit an applied one. Signature, SECURITY INVOKER, and
-- search_path all stay identical; only the credit_balance update and the
-- credit_ledger insert are removed. The return contract is unchanged —
-- 'applied' | 'duplicate' | 'survey_not_found' — so the API and web layers
-- need no change beyond their copy (this migration does not touch them).
--
-- Existing survey_responses rows, and any credits already granted by them,
-- are left untouched: this only changes what happens on the NEXT submission.
create or replace function public.submit_survey_response(
  p_profile_id uuid,
  p_survey_id  uuid,
  p_answers    jsonb
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_survey_found boolean;
  v_inserted     int;
begin
  select true into v_survey_found
  from public.surveys
  where id = p_survey_id and is_active = true;

  if not found then
    return 'survey_not_found';
  end if;

  insert into public.survey_responses (profile_id, survey_id, answers)
  values (p_profile_id, p_survey_id, p_answers)
  on conflict (profile_id, survey_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return 'duplicate';
  end if;

  return 'applied';
end;
$$;

-- The revoke/grant from 20260902130100 already restricts this function to
-- service_role; CREATE OR REPLACE does not touch privileges, so there is
-- nothing to redo here.

-- Retire the "earns you 1 free analysis credit" promise from the seeded
-- survey's description — the copy the Account page renders verbatim.
update public.surveys
set description = 'Four quick questions to help us tailor TradeSathi to how you trade.'
where slug = 'trading-profile';
