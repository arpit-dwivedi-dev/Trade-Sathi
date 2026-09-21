-- Corrects two Admin panel rules from 20260921120000_admin_reporting.sql.
--
-- 1. Revenue / paying / spent required signature_verified. That column is not
--    a trust flag: false on a captured row means verify-order confirmed the
--    capture through Razorpay's Orders API instead of a webhook signature
--    (see its column comment). Every capture that came in that way — all of
--    them, wherever the webhook is not reachable — was missing from revenue.
--    A captured payment is revenue, full stop.
--
-- 2. What counts as a user being "active".
--
-- 20260921120000_admin_reporting.sql counted any analyses row. But the hourly
-- daily-briefing job writes source='watchlist_daily' analyses on its own, so
-- every user with a watchlist looked active every day whether or not they had
-- opened the app. It also read profiles.last_active_at, which nothing writes.
--
-- An "action" is now something the user did themselves:
--   - used the app while signed in (profiles.last_active_at, now stamped by
--     the API's requireAuth, at most every few minutes per user),
--   - ran an analysis other than a scheduled briefing (source <> 'watchlist_daily'),
--   - pressed Analyze/Brief Now on a watchlist row (watchlist_analysis_runs),
--   - opened a checkout (payments),
--   - added a symbol to their watchlist (watchlist_items).

create or replace function public.admin_user_actions(
  p_since timestamptz default null
)
returns table (profile_id uuid, created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select a.profile_id, a.created_at from public.analyses a
  where a.source::text <> 'watchlist_daily' and (p_since is null or a.created_at >= p_since)
  union all
  select r.profile_id, r.created_at from public.watchlist_analysis_runs r
  where p_since is null or r.created_at >= p_since
  union all
  select pm.profile_id, pm.created_at from public.payments pm
  where p_since is null or pm.created_at >= p_since
  union all
  select w.profile_id, w.created_at from public.watchlist_items w
  where p_since is null or w.created_at >= p_since
  union all
  select p.id, p.last_active_at from public.profiles p
  where p.last_active_at is not null and (p_since is null or p.last_active_at >= p_since);
$$;

-- Most recent user action for one account, or null.
create or replace function public.admin_last_action_at(p_profile_id uuid)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(
    (select max(a.created_at) from public.analyses a
      where a.profile_id = p_profile_id and a.source::text <> 'watchlist_daily'),
    (select max(r.created_at) from public.watchlist_analysis_runs r where r.profile_id = p_profile_id),
    (select max(pm.created_at) from public.payments pm where pm.profile_id = p_profile_id),
    (select max(w.created_at) from public.watchlist_items w where w.profile_id = p_profile_id),
    (select p.last_active_at from public.profiles p where p.id = p_profile_id)
  );
$$;

-- Lifetime captured spend for one account, {currency: minor units}.
create or replace function public.admin_user_spent(p_profile_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(s.currency, s.total), '{}'::jsonb)
  from (
    select pm.currency, sum(pm.amount_minor) as total
    from public.payments pm
    where pm.profile_id = p_profile_id and pm.status = 'captured'
    group by pm.currency
  ) s;
$$;

create or replace function public.admin_user_counts(
  p_since timestamptz default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'total',  (select count(*) from public.profiles),
    'new',    (select count(*) from public.profiles
               where p_since is null or created_at >= p_since),
    'active', (select count(distinct profile_id) from public.admin_user_actions(p_since)),
    'paying', (select count(distinct profile_id) from public.payments
               where status = 'captured'
                 and (p_since is null or created_at >= p_since))
  );
$$;

create or replace function public.admin_user_rows(
  p_search text default null,
  p_limit  int default 25,
  p_offset int default 0
)
returns table (
  id             uuid,
  email          text,
  created_at     timestamptz,
  pricing_region text,
  credit_balance int,
  spent          jsonb,
  analyses       bigint,
  last_active_at timestamptz,
  total_count    bigint
)
language sql
stable
set search_path = ''
as $$
  with page as (
    select p.*, count(*) over () as total_count
    from public.profiles p
    where p_search is null or p.email ilike '%' || p_search || '%'
    order by p.created_at desc
    limit least(greatest(p_limit, 1), 100)
    offset greatest(p_offset, 0)
  )
  select
    pg.id,
    pg.email,
    pg.created_at,
    pg.pricing_region::text,
    pg.credit_balance,
    public.admin_user_spent(pg.id),
    (select count(*) from public.analyses a where a.profile_id = pg.id),
    public.admin_last_action_at(pg.id),
    pg.total_count
  from page pg
  order by pg.created_at desc;
$$;

revoke execute on function
  public.admin_user_actions(timestamptz),
  public.admin_last_action_at(uuid),
  public.admin_user_spent(uuid)
  from public, anon, authenticated;

grant execute on function
  public.admin_user_actions(timestamptz),
  public.admin_last_action_at(uuid),
  public.admin_user_spent(uuid)
  to service_role;
