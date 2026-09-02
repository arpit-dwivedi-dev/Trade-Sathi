-- ChartAnalyzer — profile survey completion credit.
--
-- Adds a small, versionable set of surveys the user fills in from the Account
-- page. Completing a survey for the first time grants 1 analysis credit;
-- completing a later survey (a new one published after this one) grants
-- another. Re-submitting the same survey grants nothing — idempotency is
-- enforced by a unique (profile_id, survey_id) row, not by client behaviour.

-- ---------------------------------------------------------------------------
-- 1. TABLE: surveys
-- ---------------------------------------------------------------------------

-- `questions` is a small JSON array of {id, prompt, type, options?} objects.
-- A dedicated question table would be premature here — nothing joins across
-- questions, and the whole point of jsonb is that a future survey with a
-- different shape needs no migration.
create table public.surveys (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  description text,
  questions   jsonb not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.surveys enable row level security;

-- Read-only for clients, same reasoning as public.plans: surveys are written
-- by migrations (or a future admin tool), never by the API using client roles.
create policy surveys_select_active on public.surveys
  for select
  to authenticated
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- 2. TABLE: survey_responses
-- ---------------------------------------------------------------------------

create table public.survey_responses (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  survey_id    uuid not null references public.surveys(id) on delete restrict,
  answers      jsonb not null,
  created_at   timestamptz not null default now(),
  -- The idempotency guard: one response per survey per user, enforced here
  -- rather than trusted to application logic.
  unique (profile_id, survey_id)
);

alter table public.survey_responses enable row level security;

-- Users may read their own responses (so the Account page can show which
-- surveys are already completed), but never write directly — a direct insert
-- would bypass the credit grant below. All writes go through
-- submit_survey_response().
create policy survey_responses_select_own on public.survey_responses
  for select
  to authenticated
  using (profile_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. FUNCTION: submit_survey_response
-- ---------------------------------------------------------------------------

-- Returns exactly one of:
--   'applied'           — response recorded, 1 credit granted and ledgered.
--   'duplicate'         — this user already completed this survey; nothing changed.
--   'survey_not_found'  — no active survey with that id; nothing changed.
--
-- SECURITY INVOKER, not DEFINER — same reasoning as apply_credit_purchase:
-- this function updates profiles.credit_balance, which Trigger C
-- (protect_profile_columns) guards by checking current_user = 'service_role'.
-- The real caller is always the backend using the service role key.
create function public.submit_survey_response(
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
  v_new_balance  int;
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

  update public.profiles
  set credit_balance = credit_balance + 1
  where id = p_profile_id
  returning credit_balance into v_new_balance;

  insert into public.credit_ledger
    (profile_id, delta, reason, ref_payment_id, balance_after)
  values
    (p_profile_id, 1, 'survey_completion', null, v_new_balance);

  return 'applied';
end;
$$;

-- Server-side only — a client able to call this could replay it against
-- crafted survey ids to mint itself credits.
revoke execute on function
  public.submit_survey_response(uuid, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function
  public.submit_survey_response(uuid, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Seed the first survey.
-- ---------------------------------------------------------------------------

insert into public.surveys (slug, title, description, questions) values (
  'trading-profile',
  'Tell us how you trade',
  'Four quick questions — completing this earns you 1 free analysis credit.',
  '[
    {
      "id": "trades_where",
      "prompt": "Where do you trade?",
      "type": "single_choice",
      "options": [
        "Indian stock market (NSE/BSE)",
        "US stock market",
        "Crypto exchanges",
        "Forex",
        "Commodity exchange (MCX)"
      ]
    },
    {
      "id": "trader_type",
      "prompt": "What type of trader are you?",
      "type": "single_choice",
      "options": ["Intraday", "Swing", "Positional", "Long-term investor", "Scalper"]
    },
    {
      "id": "invests_in",
      "prompt": "Which of these do you invest in? (select all that apply)",
      "type": "multi_choice",
      "options": [
        "Stocks",
        "Crypto",
        "Mutual funds",
        "Forex",
        "Commodities",
        "Index/derivatives"
      ]
    },
    {
      "id": "platform",
      "prompt": "Which platform do you trade on the most?",
      "type": "single_choice",
      "options": [
        "Zerodha",
        "Upstox",
        "Groww",
        "Angel One",
        "Binance",
        "MetaTrader",
        "ICICI Direct",
        "Other"
      ]
    }
  ]'::jsonb
);
