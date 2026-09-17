-- TradeSathi — promo codes: tables + the atomic redemption function.
--
-- The ledger side already existed: credit_reason includes 'promo' (seeded in
-- 20260830230000) and the logs page already renders it. This migration adds
-- only the code catalogue, the redemption record, and the function that moves
-- the balance.
--
-- Promo codes are now the only free path into a paywalled product, so all
-- three guards are structural, not application-level:
--   per-code cap      — redemption_count checked under FOR UPDATE, so
--                       concurrent redemptions cannot exceed max_redemptions
--   one-per-account   — UNIQUE (code_id, profile_id), checked with
--                       ON CONFLICT DO NOTHING + row_count
--   expiry            — expires_at is NOT NULL: every code stops working,
--                       there are no universal/no-expiry codes
--
-- Admin CRUD for these rows is a separate follow-up task. The schema is
-- shaped so that UI needs no further migration: create = INSERT, pause =
-- UPDATE is_active, re-view usage = SELECT redemption_count, extend = UPDATE
-- expires_at / max_redemptions.

-- ---------------------------------------------------------------------------
-- 1. TABLE: promo_codes
-- ---------------------------------------------------------------------------

create table public.promo_codes (
  id               uuid primary key default gen_random_uuid(),
  -- Stored as entered; compared case-insensitively via the unique index below,
  -- so LAUNCH25 / launch25 / Launch25 are one code.
  code             text not null,
  credits          int not null check (credits > 0),
  max_redemptions  int not null check (max_redemptions > 0),
  redemption_count int not null default 0 check (redemption_count >= 0),
  -- NOT NULL on purpose: expiry is one of the three required guards. A code
  -- meant to run long gets a far-future expiry set explicitly; there is no
  -- "never expires" state to accidentally leave a code in.
  expires_at       timestamptz not null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Case-insensitive uniqueness, so two admin inserts differing only in case
-- cannot create what users would experience as the same code twice.
create unique index promo_codes_code_key
  on public.promo_codes (upper(code));

alter table public.promo_codes enable row level security;

-- No client policies at all: the code list is semi-secret (a leaked list is a
-- free-credit mint) and redemption goes through the RPC below. Only the
-- service role (which bypasses RLS) reads and writes these rows.

-- ---------------------------------------------------------------------------
-- 2. TABLE: promo_redemptions
-- ---------------------------------------------------------------------------

create table public.promo_redemptions (
  id          uuid primary key default gen_random_uuid(),
  code_id     uuid not null references public.promo_codes(id) on delete restrict,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- The one-per-account guard: enforced here, never trusted to the caller.
  unique (code_id, profile_id)
);

alter table public.promo_redemptions enable row level security;

-- Same policy as credit_ledger would need if clients read it directly: they
-- do not today (the logs page reads credit_ledger, which already carries the
-- 'promo' reason), so no select policy is granted either. Service role only.

-- ---------------------------------------------------------------------------
-- 3. FUNCTION: redeem_promo_code
-- ---------------------------------------------------------------------------

-- Returns exactly one of:
--   'applied'     — credits granted, redemption recorded and ledgered.
--   'duplicate'   — this account already redeemed this code; nothing changed.
--   'invalid_code'— no such code, or it is inactive; nothing changed.
--   'expired'     — the code's expiry has passed; nothing changed.
--   'exhausted'   — the code's redemption cap is reached; nothing changed.
--
-- Modeled on submit_survey_response (20260902130100): validate, INSERT with
-- the unique constraint as the idempotency guard, treat a zero row_count as
-- the duplicate case, update the balance, write the ledger row.
--
-- SECURITY INVOKER, deliberately — NOT SECURITY DEFINER: this function
-- updates profiles.credit_balance, which Trigger C (protect_profile_columns)
-- guards by checking current_user = 'service_role'. Under DEFINER,
-- current_user inside the body becomes the function's owner, and Trigger C
-- would block the write. The real caller is always the backend using the
-- service role key, which already holds sufficient table privileges.
--
-- The SELECT ... FOR UPDATE on the promo_codes row is what makes the cap
-- race-proof: two concurrent redemptions of the same code serialize on the
-- row lock, and the second one — under READ COMMITTED, FOR UPDATE re-reads
-- the row after the lock is granted — sees the first one's incremented
-- redemption_count, not a stale copy. Without it, both could read
-- count = max-1 and both proceed.
--
-- SET search_path = '' (empty) hardens it against search_path hijacking, so
-- every reference below is fully qualified.
create function public.redeem_promo_code(
  p_profile_id uuid,
  p_code       text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_code        public.promo_codes%rowtype;
  v_inserted    int;
  v_new_balance int;
begin
  select * into v_code
  from public.promo_codes
  where upper(code) = upper(btrim(p_code))
  for update;

  -- Unknown and inactive collapse into the same answer on purpose: telling a
  -- caller which guessed codes used to be real is a free enumeration oracle.
  if not found or not v_code.is_active then
    return 'invalid_code';
  end if;

  if now() > v_code.expires_at then
    return 'expired';
  end if;

  if v_code.redemption_count >= v_code.max_redemptions then
    return 'exhausted';
  end if;

  insert into public.promo_redemptions (code_id, profile_id)
  values (v_code.id, p_profile_id)
  on conflict (code_id, profile_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return 'duplicate';
  end if;

  update public.promo_codes
  set redemption_count = redemption_count + 1
  where id = v_code.id;

  update public.profiles
  set credit_balance = credit_balance + v_code.credits
  where id = p_profile_id
  returning credit_balance into v_new_balance;

  -- The caller is the backend, which resolves p_profile_id from a verified
  -- JWT — a miss here is a programming error, not a user input problem.
  if v_new_balance is null then
    raise exception 'No profile found for promo redemption: %', p_profile_id;
  end if;

  insert into public.credit_ledger
    (profile_id, delta, reason, balance_after)
  values
    (p_profile_id, v_code.credits, 'promo', v_new_balance);

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only: a client able to call this could redeem codes directly,
-- and more importantly any future client-callable variant would still be
-- fine — the guards are inside — but there is no reason to allow it, and
-- anon/authenticated EXECUTE would put the code-existence oracle one guess
-- per request away.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC. Supabase
-- auto-grants EXECUTE on new public-schema functions directly to both roles,
-- so those grants are held in their own right and would survive a revoke from
-- PUBLIC alone.
revoke execute on function
  public.redeem_promo_code(uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.redeem_promo_code(uuid, text)
  to service_role;
