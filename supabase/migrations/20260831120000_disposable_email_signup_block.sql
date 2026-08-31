-- Disposable / temp-email signup protection.
--
-- Domain data is sourced from the `disposable-email-domains` npm package and
-- seeded by the generated companion migration
-- (20260831120100_seed_disposable_email_domains.sql). Regenerate that file with
-- `pnpm gen:disposable-domains <new timestamp>` after bumping the package.
--
-- Enforcement is a Supabase "before user created" auth hook, so it applies to
-- every signup path — including someone calling the Supabase REST API directly
-- with the public anon key, which a client-side check cannot stop.

-- Exact-match domains, e.g. `mailinator.com`.
create table if not exists public.disposable_email_domains (
  domain text primary key
);

-- Wildcard suffixes: block the suffix itself and any subdomain of it,
-- e.g. `10mail.org` also blocks `foo.10mail.org`.
create table if not exists public.disposable_email_wildcards (
  suffix text primary key
);

-- Reference data, not user data: no policies are defined, so RLS denies all
-- access through PostgREST. The hook below reads these as security definer.
alter table public.disposable_email_domains enable row level security;
alter table public.disposable_email_wildcards enable row level security;

create or replace function public.is_disposable_email_domain(email_domain text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with parts as (
    select string_to_array(email_domain, '.') as segments
  ),
  -- Every parent suffix of the domain: foo.bar.example.com ->
  -- {foo.bar.example.com, bar.example.com, example.com, com}
  suffixes as (
    select array_to_string(p.segments[i:], '.') as suffix
    from parts p, generate_subscripts(p.segments, 1) as i
  )
  select exists (
    select 1 from public.disposable_email_domains d where d.domain = email_domain
  ) or exists (
    select 1
    from public.disposable_email_wildcards w
    join suffixes s on s.suffix = w.suffix
  );
$$;

create or replace function public.reject_disposable_email_signup(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- Domain is everything after the LAST '@', matching how mail servers parse
  -- an address. Using split_part(.., '@', 2) would read `b` out of
  -- `a@b@mailinator.com` and miss the real domain.
  email_domain text := lower(
    trim(substring(coalesce(event -> 'user' ->> 'email', '') from '[^@]*$'))
  );
begin
  if email_domain = '' then
    return jsonb_build_object();
  end if;

  if public.is_disposable_email_domain(email_domain) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message', 'Please sign up with a permanent email address — temporary and disposable email providers are not accepted.'
      )
    );
  end if;

  return jsonb_build_object();
end;
$$;

grant execute on function public.reject_disposable_email_signup(jsonb) to supabase_auth_admin;

revoke execute on function public.reject_disposable_email_signup(jsonb) from anon, authenticated, public;
revoke execute on function public.is_disposable_email_domain(text) from anon, authenticated, public;
