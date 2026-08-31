-- Hardens the disposable-email hook's address parsing.
--
-- The previous body extracted the domain with substring(email from '[^@]*$'),
-- which returns the WHOLE string when the address contains no '@' — so
-- `mailinator.com` submitted as the entire email was read as a domain. Auth
-- validates address format before this hook runs, so nothing reached it in
-- practice, but the hook should not depend on that.
--
-- Only the function body changes; the tables and is_disposable_email_domain
-- from 20260831120000 are untouched.
create or replace function public.reject_disposable_email_signup(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  raw_email text := coalesce(event -> 'user' ->> 'email', '');
  email_domain text;
begin
  -- No '@' means this is not an address; leave it to Auth's own validation.
  if position('@' in raw_email) = 0 then
    return jsonb_build_object();
  end if;

  -- Domain is everything after the LAST '@', matching how mail servers parse
  -- an address. split_part(.., '@', 2) would read `b` out of
  -- `a@b@mailinator.com` and miss the real domain.
  email_domain := lower(trim(substring(raw_email from '[^@]*$')));

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
