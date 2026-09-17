-- TradeSathi — the rest of the Account page's editable profile.
--
-- full_name already existed; these three round it out into a proper profile
-- (contact number, occupation, location) without touching anything the
-- survey already covers (trading markets, trader type, platform — see
-- 20260902130100_profile_survey_credits.sql).
--
-- None of the three are added to protect_profile_columns()'s guarded list:
-- like full_name, they carry no entitlement or pricing meaning, so there is
-- nothing for a client-side write to exploit.
alter table public.profiles
  add column phone_number text,
  add column profession   text,
  add column location     text;
