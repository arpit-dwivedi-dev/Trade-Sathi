export const SHARED_PLACEHOLDER = true;

/** A row from public.instruments — the canonical NSE/BSE symbol identity used by the watchlist. */
export interface Instrument {
  id: string;
  exchange: string;
  symbol: string;
  name: string;
  instrumentType: string;
}

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

/**
 * Wire protocol for the live market-data socket (`/api/market/stream`).
 *
 * The API proxies Yahoo Finance's streaming socket rather than the browser
 * connecting to it directly, so this is the one contract between them. It
 * lives here, not in either app, because a message the server sends and the
 * client never learns to read is a silent failure — the compiler should catch
 * a divergence.
 *
 * A browser cannot set headers on a WebSocket handshake, so the session
 * authenticates with an `auth` message as its first frame rather than an
 * Authorization header. The token is deliberately not a query parameter:
 * URLs end up in access logs, and this one is a bearer credential.
 */

/** Messages the browser sends. */
export type MarketStreamClientMessage =
  | { type: 'auth'; token: string }
  /** One instrument at a time — this replaces any previous subscription. */
  | { type: 'subscribe'; instrumentId: string }
  | { type: 'unsubscribe' };

/**
 * A single price update. Deliberately just the traded price and when it
 * traded: the provider's frame carries more (day high/low, volume, session),
 * but nothing on the live chart reads those, and a field on the wire that no
 * client consumes is a contract to keep for no benefit.
 */
export interface MarketTick {
  instrumentId: string;
  price: number;
  /** Epoch milliseconds. */
  time: number;
}

/** Messages the API sends. */
export type MarketStreamServerMessage =
  | { type: 'ready' }
  | { type: 'subscribed'; instrumentId: string }
  | { type: 'tick'; tick: MarketTick }
  | { type: 'error'; code: 'unauthorized' | 'not_found' | 'bad_request'; message: string };
