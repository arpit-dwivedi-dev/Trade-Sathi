-- "Online now" for the Admin panel: accounts whose last_active_at is within
-- the last 3 minutes. The web app pings the API every 60s while a tab is
-- visible and the API stamps last_active_at at most once a minute per user
-- (services/last-active.service.ts), so an open tab stays inside the window
-- and a closed one drops out of it within about three minutes.

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
                 and (p_since is null or created_at >= p_since)),
    'online', (select count(*) from public.profiles
               where last_active_at >= now() - interval '3 minutes')
  );
$$;
