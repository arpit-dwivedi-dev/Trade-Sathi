export const SHARED_PLACEHOLDER = true;

/**
 * Fast-path list of the disposable/temp-email providers people reach for most
 * often, used only to fail the signup form instantly without a round trip.
 *
 * This is deliberately NOT the full blocklist. Enforcement lives in the
 * `before_user_created` Postgres auth hook, which checks all ~121k domains from
 * the `disposable-email-domains` package (see
 * supabase/migrations/20260831120000_disposable_email_signup_block.sql). That
 * full list is ~2.4MB, far too large to ship to the browser — and a client
 * check is bypassable anyway, so the hook is the real boundary.
 *
 * Anything missed here is still rejected by the hook, whose error message
 * surfaces on the form. Keep this short; it never needs to be exhaustive.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '0-mail.com',
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  '33mail.com',
  'dispostable.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'harakirimail.com',
  'inboxbear.com',
  'jetable.org',
  'mailcatch.com',
  'mailinator.com',
  'mailinator.net',
  'mailnesia.com',
  'maildrop.cc',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mytemp.email',
  'sharklasers.com',
  'spamgourmet.com',
  'temp-mail.org',
  'temp-mail.io',
  'tempail.com',
  'tempinbox.com',
  'tempmail.com',
  'tempmail.net',
  'tempmailo.com',
  'temporary-mail.net',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@').pop();
  return !!domain && DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
