-- Read-only reporting functions for the Admin panel (apps/api routes/admin.route.ts).
--
-- Aggregates are done here rather than in the API because PostgREST caps an
-- unranged select at 1000 rows: summing analyses/payments client-side would
-- silently undercount as soon as the tables outgrow that. Each function returns
-- either one page of rows (with the total count on every row) or a small
-- grouped result; the business rules applied to those groups — what counts as
-- revenue, how currencies stay apart, what "estimated" P&L means — live in
-- apps/api services/admin-metrics.ts, where they are unit-tested.
--
-- Every function is server-only: EXECUTE is revoked from anon/authenticated
-- and granted to service_role, so the admin gate in the API (requireAdmin) is
-- the only way in.

-- ---------------------------------------------------------------------------
-- Indexes for the admin list/sort paths that had none.
-- ---------------------------------------------------------------------------

create index if not exists payments_created_at_idx on public.payments (created_at desc);
create index if not exists app_error_logs_created_at_idx on public.app_error_logs (created_at desc);
create index if not exists profiles_created_at_idx on public.profiles (created_at desc);
create index if not exists analyses_created_at_idx on public.analyses (created_at desc);
create index if not exists credit_ledger_ref_analysis_id_idx
  on public.credit_ledger (ref_analysis_id) where ref_analysis_id is not null;

-- ---------------------------------------------------------------------------
-- Per-analysis economics, shared by the row and group functions below.
--
-- credits: the net ledger movement referencing the analysis when one exists;
-- otherwise the feature's current credit cost (0 for a failed analysis, which
-- is refunded). Consumption rows are usually written before the analysis row
-- exists, so most carry no ref_analysis_id — hence the fallback, and hence
-- "estimated".
--
-- revenue_minor: credits x the account's regional price per credit, in that
-- region's currency. A region not locked yet is priced as 'IN', the same
-- fallback ensurePricingRegion uses.
-- ---------------------------------------------------------------------------

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
    and (p_profile_id is null or a.profile_id = p_profile_id);
$$;

-- One page of analysis-level economics, newest first.
create or replace function public.admin_analysis_rows(
  p_since      timestamptz default null,
  p_until      timestamptz default null,
  p_source     text default null,
  p_model      text default null,
  p_status     text default null,
  p_profile_id uuid default null,
  p_limit      int default 25,
  p_offset     int default 0
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
  created_at    timestamptz,
  total_count   bigint
)
language sql
stable
set search_path = ''
as $$
  select e.*, count(*) over () as total_count
  from public.admin_analysis_economics(p_since, p_until, p_source, p_model, p_status, p_profile_id) e
  order by e.created_at desc
  limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
$$;

-- Analysis economics grouped by IST day x source x model x status x currency.
-- Small by construction; the API folds it into totals, breakdowns and trends.
create or replace function public.admin_analysis_groups(
  p_since  timestamptz default null,
  p_until  timestamptz default null,
  p_source text default null,
  p_model  text default null,
  p_status text default null
)
returns table (
  day           date,
  source        text,
  model_id      text,
  status        text,
  currency      text,
  analyses      bigint,
  cost_usd      numeric,
  credits       bigint,
  revenue_minor bigint
)
language sql
stable
set search_path = ''
as $$
  select
    (e.created_at at time zone 'Asia/Kolkata')::date,
    e.source,
    e.model_id,
    e.status,
    e.currency,
    count(*),
    coalesce(sum(e.cost_usd), 0),
    coalesce(sum(e.credits), 0),
    coalesce(sum(e.revenue_minor), 0)
  from public.admin_analysis_economics(p_since, p_until, p_source, p_model, p_status, null) e
  group by 1, 2, 3, 4, 5;
$$;

-- Payments grouped by IST day x currency x status x signature_verified.
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
  where p_since is null or pm.created_at >= p_since
  group by 1, 2, 3, 4;
$$;

-- User headcounts for the Overview KPIs.
--   active: made at least one analysis in the window.
--   paying: has at least one captured, signature-verified payment in the window.
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
    'active', (select count(distinct profile_id) from public.analyses
               where p_since is null or created_at >= p_since),
    'paying', (select count(distinct profile_id) from public.payments
               where status = 'captured' and signature_verified
                 and (p_since is null or created_at >= p_since))
  );
$$;

-- One page of users with their spend and usage totals, newest signup first.
-- spent is {currency: minor units} of captured, verified payments — never
-- summed across currencies.
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
    coalesce((
      select jsonb_object_agg(s.currency, s.total)
      from (
        select pm.currency, sum(pm.amount_minor) as total
        from public.payments pm
        where pm.profile_id = pg.id and pm.status = 'captured' and pm.signature_verified
        group by pm.currency
      ) s
    ), '{}'::jsonb),
    (select count(*) from public.analyses a where a.profile_id = pg.id),
    greatest(
      pg.last_active_at,
      (select max(a.created_at) from public.analyses a where a.profile_id = pg.id)
    ),
    pg.total_count
  from page pg
  order by pg.created_at desc;
$$;

-- Platform activity counts for the Activity tab.
create or replace function public.admin_activity_counts(
  p_since timestamptz default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'watchlistItems',      (select count(*) from public.watchlist_items),
    'watchlistItemsAdded', (select count(*) from public.watchlist_items
                            where p_since is null or created_at >= p_since),
    'watchlistUsers',      (select count(distinct profile_id) from public.watchlist_items),
    'watchlistRuns', coalesce((
      select jsonb_object_agg(status, n) from (
        select status::text as status, count(*) as n
        from public.watchlist_analysis_runs
        where p_since is null or created_at >= p_since
        group by 1
      ) s
    ), '{}'::jsonb),
    'briefings', coalesce((
      select jsonb_object_agg(status, n) from (
        select status::text as status, count(*) as n
        from public.daily_briefing_log
        where p_since is null or created_at >= p_since
        group by 1
      ) s
    ), '{}'::jsonb)
  );
$$;

-- Server-only. anon and authenticated are revoked explicitly, not just via
-- PUBLIC — Supabase auto-grants EXECUTE on new public-schema functions to both
-- roles directly, so a revoke from PUBLIC alone would leave them callable.
revoke execute on function
  public.admin_analysis_economics(timestamptz, timestamptz, text, text, text, uuid),
  public.admin_analysis_rows(timestamptz, timestamptz, text, text, text, uuid, int, int),
  public.admin_analysis_groups(timestamptz, timestamptz, text, text, text),
  public.admin_payment_groups(timestamptz),
  public.admin_user_counts(timestamptz),
  public.admin_user_rows(text, int, int),
  public.admin_activity_counts(timestamptz)
  from public, anon, authenticated;

grant execute on function
  public.admin_analysis_economics(timestamptz, timestamptz, text, text, text, uuid),
  public.admin_analysis_rows(timestamptz, timestamptz, text, text, text, uuid, int, int),
  public.admin_analysis_groups(timestamptz, timestamptz, text, text, text),
  public.admin_payment_groups(timestamptz),
  public.admin_user_counts(timestamptz),
  public.admin_user_rows(text, int, int),
  public.admin_activity_counts(timestamptz)
  to service_role;
