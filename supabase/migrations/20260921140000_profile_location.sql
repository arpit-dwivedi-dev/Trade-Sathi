-- Where users are, from their IP, for the Admin panel.
--
-- City-level at best, from the geoip lookup the API already runs on every
-- request (middleware/geo.ts) — no browser permission, no GPS. Two snapshots
-- per account: where it was first seen, and where it was last seen. No
-- history table and no raw IP is kept.
--
-- Written only by touch_profile_activity, which the API calls from requireAuth
-- in the same throttled write that stamps last_active_at.

alter table public.profiles
  add column first_seen_country text,
  add column first_seen_region  text,
  add column first_seen_city    text,
  add column first_seen_at      timestamptz,
  add column last_seen_country  text,
  add column last_seen_region   text,
  add column last_seen_city     text,
  add column last_seen_at       timestamptz;

comment on column public.profiles.first_seen_country is
  'ISO country code the account was first seen from, by IP lookup. City-level at best; VPNs and mobile carriers can misplace it.';
comment on column public.profiles.last_seen_country is
  'ISO country code the account was most recently seen from, by IP lookup. Same caveats as first_seen_country.';

-- Stamps activity and, when the IP resolved to a country, location. An
-- unresolved lookup (localhost, private IP) leaves the last known location
-- as it was rather than blanking it. first_seen_* is written once.
create or replace function public.touch_profile_activity(
  p_profile_id uuid,
  p_country    text default null,
  p_region     text default null,
  p_city       text default null
)
returns void
language sql
set search_path = ''
as $$
  update public.profiles p set
    last_active_at     = now(),
    last_seen_country  = case when p_country is not null then p_country  else p.last_seen_country end,
    last_seen_region   = case when p_country is not null then p_region   else p.last_seen_region end,
    last_seen_city     = case when p_country is not null then p_city     else p.last_seen_city end,
    last_seen_at       = case when p_country is not null then now()      else p.last_seen_at end,
    first_seen_country = case when p.first_seen_at is null and p_country is not null then p_country else p.first_seen_country end,
    first_seen_region  = case when p.first_seen_at is null and p_country is not null then p_region  else p.first_seen_region end,
    first_seen_city    = case when p.first_seen_at is null and p_country is not null then p_city    else p.first_seen_city end,
    first_seen_at      = case when p.first_seen_at is null and p_country is not null then now()     else p.first_seen_at end
  where p.id = p_profile_id;
$$;

-- admin_user_rows gains the location columns; a changed return type needs a
-- drop, not just create or replace.
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
    pg.total_count
  from page pg
  order by pg.created_at desc;
$$;

-- Users by last-seen location, for the Overview breakdown. Everyone with a
-- known location, not windowed: it answers "where is our user base".
create or replace function public.admin_location_counts()
returns table (country text, region text, city text, users bigint)
language sql
stable
set search_path = ''
as $$
  select p.last_seen_country, p.last_seen_region, p.last_seen_city, count(*)
  from public.profiles p
  where p.last_seen_country is not null
  group by 1, 2, 3;
$$;

revoke execute on function
  public.touch_profile_activity(uuid, text, text, text),
  public.admin_user_rows(text, int, int),
  public.admin_location_counts()
  from public, anon, authenticated;

grant execute on function
  public.touch_profile_activity(uuid, text, text, text),
  public.admin_user_rows(text, int, int),
  public.admin_location_counts()
  to service_role;
