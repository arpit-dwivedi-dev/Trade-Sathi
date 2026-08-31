-- Supabase Auth "before user created" hook: rejects signups from a curated
-- list of disposable/temp-email domains. Kept in sync manually with
-- packages/shared/src/disposable-email.ts, since that list is TypeScript and
-- this function runs inside Postgres.
create or replace function public.reject_disposable_email_signup(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  user_email text := event -> 'user' ->> 'email';
  email_domain text := lower(split_part(coalesce(event -> 'user' ->> 'email', ''), '@', 2));
  disposable_domains text[] := array[
    '0-mail.com', '10minutemail.com', '10minutemail.net', '20minutemail.com',
    '33mail.com', 'dispostable.com', 'fakeinbox.com', 'getairmail.com',
    'getnada.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
    'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com', 'jetable.org',
    'mailcatch.com', 'mailinator.com', 'mailinator.net', 'mailnesia.com',
    'maildrop.cc', 'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email',
    'sharklasers.com', 'spamgourmet.com', 'temp-mail.org', 'temp-mail.io',
    'tempail.com', 'tempinbox.com', 'tempmail.com', 'tempmail.net',
    'tempmailo.com', 'temporary-mail.net', 'throwawaymail.com', 'trashmail.com',
    'trashmail.net', 'yopmail.com', 'yopmail.fr', 'yopmail.net'
  ];
begin
  if user_email is null then
    return jsonb_build_object();
  end if;

  if email_domain = any(disposable_domains) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message', 'Please sign up with a permanent email address — temporary/disposable emails are not allowed.'
      )
    );
  end if;

  return jsonb_build_object();
end;
$$;

grant execute on function public.reject_disposable_email_signup(jsonb) to supabase_auth_admin;

revoke execute on function public.reject_disposable_email_signup(jsonb) from authenticated, anon, public;
