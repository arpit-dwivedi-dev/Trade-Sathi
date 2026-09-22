-- Accounts the Admin panel leaves out of its numbers (test accounts, the
-- owner's own account, ...). An excluded account still appears in the Users
-- list, with its own detail, but none of its analyses, payments, activity or
-- location feed any total, trend, breakdown or list elsewhere in the panel.
--
-- A separate table rather than a profiles column: users can update their own
-- profiles row (profiles_update_own), and this flag is the admin's alone. RLS
-- is on with no policies, so only the service role reaches it.

create table public.admin_excluded_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_excluded_profiles enable row level security;

create or replace function public.admin_is_excluded(p_profile_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.admin_excluded_profiles x where x.profile_id = p_profile_id);
$$;

-- Economics: excluded accounts drop out unless one account is asked for by id
-- (the per-user detail drawer), which still shows that account's history.
create or replace function public.admin_analysis_economics(
  p_since      timestamptz default null,
  p_until      timestamptz default null,
  p_source     text default null,
  p_model      text default null,
  p_status     text default null,
  p_profile_id uuid default null
)
returns table (
  id            uuid,
  profile_id    uuid,
  email         text,
  source        text,
  model_id      text,
  status        text,
  cost_usd      numeric,
  credits       int,
  revenue_minor bigint,
  currency      text,
  error_code    text,
  error_message text,
  created_at    timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    a.id,
    a.profile_id,
    p.email,
    a.source::text,
    a.model_id,
    a.status::text,
    a.cost_usd,
    c.credits,
    (c.credits * coalesce(r.price_per_credit_minor, 0))::bigint,
    r.currency,
    a.error_code,
    a.error_message,
    a.created_at
  from public.analyses a
  join public.profiles p on p.id = a.profile_id
  left join public.credit_pricing_regions r
    on r.region = coalesce(p.pricing_region, 'IN'::public.pricing_region)
  left join lateral (
    select -sum(l.delta)::int as net
    from public.credit_ledger l
    where l.ref_analysis_id = a.id
      and l.reason in ('feature_consumption', 'refund')
  ) led on true
  left join public.feature_credit_costs f
    on f.feature_key = case a.source::text
      when 'fundamentals'    then 'fundamental_analysis'
      when 'watchlist_daily' then 'daily_briefing_run'
      else 'chart_analysis'
    end
  cross join lateral (
    select greatest(
      coalesce(led.net, case when a.status = 'failed' then 0 else coalesce(f.credits, 0) end),
      0
    ) as credits
  ) c
  where (p_since is null or a.created_at >= p_since)
    and (p_until is null or a.created_at < p_until)
    and (p_source is null or a.source::text = p_source)
    and (p_model is null or a.model_id = p_model)
    and (p_status is null or a.status::text = p_status)
    and (p_profile_id is null or a.profile_id = p_profile_id)
    and (p_profile_id is not null or not public.admin_is_excluded(a.profile_id));
$$;

create or replace function public.admin_payment_groups(
  p_since timestamptz default null
)
returns table (
  day                date,
  currency           text,
  status             text,
  signature_verified boolean,
  payments           bigint,
  amount_minor       bigint
)
language sql
stable
set search_path = ''
as $$
  select
    (pm.created_at at time zone 'Asia/Kolkata')::date,
    pm.currency,
    pm.status,
    pm.signature_verified,
    count(*),
    coalesce(sum(pm.amount_minor), 0)
  from public.payments pm
  where (p_since is null or pm.created_at >= p_since)
    and not public.admin_is_excluded(pm.profile_id)
  group by 1, 2, 3, 4;
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
    'total',  (select count(*) from public.profiles p
               where not public.admin_is_excluded(p.id)),
    'new',    (select count(*) from public.profiles p
               where (p_since is null or p.created_at >= p_since)
                 and not public.admin_is_excluded(p.id)),
    'active', (select count(distinct u.profile_id) from public.admin_user_actions(p_since) u
               where not public.admin_is_excluded(u.profile_id)),
    'paying', (select count(distinct pm.profile_id) from public.payments pm
               where pm.status = 'captured'
                 and (p_since is null or pm.created_at >= p_since)
                 and not public.admin_is_excluded(pm.profile_id)),
    'online', (select count(*) from public.profiles p
               where p.last_active_at >= now() - interval '3 minutes'
                 and not public.admin_is_excluded(p.id))
  );
$$;

create or replace function public.admin_location_counts()
returns table (country text, region text, city text, users bigint)
language sql
stable
set search_path = ''
as $$
  select p.last_seen_country, p.last_seen_region, p.last_seen_city, count(*)
  from public.profiles p
  where p.last_seen_country is not null
    and not public.admin_is_excluded(p.id)
  group by 1, 2, 3;
$$;

create or replace function public.admin_activity_counts(
  p_since timestamptz default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'watchlistItems',      (select count(*) from public.watchlist_items w
                            where not public.admin_is_excluded(w.profile_id)),
    'watchlistItemsAdded', (select count(*) from public.watchlist_items w
                            where (p_since is null or w.created_at >= p_since)
                              and not public.admin_is_excluded(w.profile_id)),
    'watchlistUsers',      (select count(distinct w.profile_id) from public.watchlist_items w
                            where not public.admin_is_excluded(w.profile_id)),
    'watchlistRuns', coalesce((
      select jsonb_object_agg(status, n) from (
        select r.status::text as status, count(*) as n
        from public.watchlist_analysis_runs r
        where (p_since is null or r.created_at >= p_since)
          and not public.admin_is_excluded(r.profile_id)
        group by 1
      ) s
    ), '{}'::jsonb),
    'briefings', coalesce((
      select jsonb_object_agg(status, n) from (
        select b.status::text as status, count(*) as n
        from public.daily_briefing_log b
        where (p_since is null or b.created_at >= p_since)
          and not public.admin_is_excluded(b.profile_id)
        group by 1
      ) s
    ), '{}'::jsonb)
  );
$$;

-- The Users list keeps every account and gains the flag, so the toggle can
-- show it. A changed return type needs a drop, not just create or replace.
drop function public.admin_user_rows(text, int, int);

create function public.admin_user_rows(
  p_search text default null,
  p_limit  int default 25,
  p_offset int default 0
)
returns table (
  id                 uuid,
  email              text,
  created_at         timestamptz,
  pricing_region     text,
  credit_balance     int,
  spent              jsonb,
  analyses           bigint,
  last_active_at     timestamptz,
  first_seen_country text,
  first_seen_region  text,
  first_seen_city    text,
  last_seen_country  text,
  last_seen_region   text,
  last_seen_city     text,
  last_seen_at       timestamptz,
  excluded           boolean,
  total_count        bigint
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
    pg.first_seen_country,
    pg.first_seen_region,
    pg.first_seen_city,
    pg.last_seen_country,
    pg.last_seen_region,
    pg.last_seen_city,
    pg.last_seen_at,
    public.admin_is_excluded(pg.id),
    pg.total_count
  from page pg
  order by pg.created_at desc;
$$;

revoke all on table public.admin_excluded_profiles from anon, authenticated;

revoke execute on function
  public.admin_is_excluded(uuid),
  public.admin_user_rows(text, int, int)
  from public, anon, authenticated;

grant execute on function
  public.admin_is_excluded(uuid),
  public.admin_user_rows(text, int, int)
  to service_role;
