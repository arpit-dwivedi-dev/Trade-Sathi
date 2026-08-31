/**
 * Curated list of disposable/temp-email provider domains. Not exhaustive —
 * covers the common ones people reach for to farm free trials. Kept in sync
 * manually with the copy embedded in
 * supabase/migrations/20260831120000_block_disposable_email_signup.sql,
 * since that copy lives in a Postgres function and can't import this file.
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
