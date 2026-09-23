-- Promo codes made for one person.
--
-- The Admin panel's Promo codes section can issue a code that only one email
-- address can redeem: a user asks for more beta credits, a partner gets their
-- own code. The restriction is the email rather than a profile id, which
-- does two things:
--   * a code can be issued before its owner has signed up — it starts
--     working once they create an account with that address;
--   * it needs no foreign key to profiles. promo_redemptions.code_id is
--     ON DELETE RESTRICT, so a cascade from a deleted profile onto its own
--     code would fail on the code's redemptions, and SET NULL would quietly
--     turn a personal code into one anybody can use.
--
-- Stored lower-cased and trimmed; compared against lower(profiles.email).
--
-- Free credits only. The discount path (begin_credit_purchase) does not read
-- this column, so the check constraint keeps a restricted code from ever
-- carrying a discount rather than teaching that path about it.

alter table public.promo_codes
  add column restricted_email text
    check (restricted_email is null or restricted_email = lower(btrim(restricted_email)));

alter table public.promo_codes
  add constraint promo_codes_restricted_credits_only check (
    restricted_email is null
    or (discount_percent is null and discount_fixed_minor is null)
  );

-- ---------------------------------------------------------------------------
-- FUNCTION: redeem_promo_code_credits (recreated with the email restriction)
-- ---------------------------------------------------------------------------

-- Unchanged from 20260917150200_credit_billing_functions.sql except for the
-- restricted_email check. A code made for someone else answers exactly like
-- an unknown code ('invalid_code'): saying "this code exists but is not
-- yours" would confirm a guessed code, the same enumeration oracle the
-- original function's comment explains.
create or replace function public.redeem_promo_code_credits(
  p_profile_id uuid,
  p_code       text,
  p_region     pricing_region
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_code           public.promo_codes%rowtype;
  v_prior_count    int;
  v_new_balance    int;
begin
  select * into v_code
  from public.promo_codes
  where upper(code) = upper(btrim(p_code))
  for update;

  if not found or not v_code.is_active or v_code.free_credits is null then
    return 'invalid_code';
  end if;

  if v_code.restricted_email is not null
     and not exists (
       select 1
       from public.profiles
       where id = p_profile_id
         and lower(email) = v_code.restricted_email
     )
  then
    return 'invalid_code';
  end if;

  if v_code.starts_at is not null and now() < v_code.starts_at then
    return 'invalid_code';
  end if;

  if v_code.expires_at is not null and now() > v_code.expires_at then
    return 'expired';
  end if;

  if v_code.region_eligibility is not null
     and array_length(v_code.region_eligibility, 1) > 0
     and not (p_region = any (v_code.region_eligibility))
  then
    return 'not_eligible_region';
  end if;

  if v_code.max_redemptions is not null
     and v_code.redemption_count >= v_code.max_redemptions
  then
    return 'exhausted';
  end if;

  select count(*) into v_prior_count
  from public.promo_redemptions
  where code_id = v_code.id
    and profile_id = p_profile_id
    and redemption_type = 'free_credits';

  if v_prior_count >= v_code.per_user_limit then
    return 'duplicate';
  end if;

  update public.promo_codes
  set redemption_count = redemption_count + 1
  where id = v_code.id;

  update public.profiles
  set credit_balance = credit_balance + v_code.free_credits
  where id = p_profile_id
  returning credit_balance into v_new_balance;

  -- The caller is the backend, which resolves p_profile_id from a verified
  -- JWT — a miss here is a programming error, not a user input problem.
  if v_new_balance is null then
    raise exception 'No profile found for promo redemption: %', p_profile_id;
  end if;

  insert into public.promo_redemptions (code_id, profile_id, redemption_type, credits_granted)
  values (v_code.id, p_profile_id, 'free_credits', v_code.free_credits);

  insert into public.credit_ledger (profile_id, delta, reason, ref_promo_code_id, balance_after)
  values (p_profile_id, v_code.free_credits, 'promo_credit', v_code.id, v_new_balance);

  return 'applied';
end;
$$;

-- CREATE OR REPLACE keeps the grants the original function was given, but
-- they are restated so this file alone says who may call it (see the
-- original's note on Supabase auto-granting EXECUTE to anon/authenticated).
revoke execute on function public.redeem_promo_code_credits(uuid, text, pricing_region)
  from public, anon, authenticated;

grant execute on function public.redeem_promo_code_credits(uuid, text, pricing_region)
  to service_role;
