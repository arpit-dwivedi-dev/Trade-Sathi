export const SHARED_PLACEHOLDER = true;

// The billing/pricing contract: region bands, the public pricing overview,
// and promo redemption. See billing.ts.
export * from './billing.js';

// The AI analysis contract: the shape apps/api validates the model's json into
// and stores, and the shape apps/web renders back. See chart-analysis.ts.
export * from './chart-analysis.js';

// The fundamentals contract: the shape apps/api reads out of the market-data
// provider and apps/web's Fundamentals tab renders. See fundamentals.ts.
export * from './fundamentals.js';

// The fundamentals AI analysis contract: the shape apps/api validates the
// model's json into and stores, and the shape apps/web renders back. See
// fundamentals-analysis.ts.
export * from './fundamentals-analysis.js';

// The derived-fundamentals contract: every ratio the report reasons about,
// computed by apps/api from period-stamped raw statements rather than read
// from a provider's pre-computed field. See fundamentals-derived.ts.
export * from './fundamentals-derived.js';

/** A row from public.instruments — the canonical symbol identity used by the watchlist. */
export interface Instrument {
  id: string;
  exchange: string;
  symbol: string;
  name: string;
  instrumentType: string;
  /** Resolved once per instrument and cached in the DB — see instrument-logo.service.ts. Absent until resolved, or if no logo could be found. */
  logoUrl?: string;
}

/**
 * Stock markets instrument search can be scoped to. NSE/BSE are backed by
 * the imported instrument catalogue; NASDAQ/NYSE are resolved on demand
 * through Yahoo Finance's own symbol search — see
 * apps/api/src/services/instruments.service.ts.
 */
export const MARKETS = [
  { code: 'NSE', label: 'NSE (India)', flag: '🇮🇳' },
  { code: 'BSE', label: 'BSE (India)', flag: '🇮🇳' },
  { code: 'NASDAQ', label: 'NASDAQ (US)', flag: '🇺🇸' },
  { code: 'NYSE', label: 'NYSE (US)', flag: '🇺🇸' },
] as const;

export type MarketCode = (typeof MARKETS)[number]['code'];

export function isMarketCode(value: string): value is MarketCode {
  return MARKETS.some((m) => m.code === value);
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

/**
 * A single question on a profile survey (public.surveys.questions).
 * 'text' renders as a free-text input; 'single_choice' renders `options` as
 * radio buttons; 'multi_choice' renders them as checkboxes and the answer is
 * the selected options joined with ", " (SurveyAnswers stays a flat
 * Record<string, string> either way — one more answer type was not worth a
 * richer value shape). Kept intentionally small — nothing here branches on
 * question type beyond how it renders.
 */
export interface SurveyQuestion {
  id: string;
  prompt: string;
  type: 'text' | 'single_choice' | 'multi_choice';
  options?: string[];
}

/** A row from public.surveys, as returned by GET /api/survey. */
export interface SurveyDefinition {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  questions: SurveyQuestion[];
}

/**
 * The Account page's view of "is there a survey to fill in right now, and has
 * this user already done it". `survey` is null once every active survey has
 * been completed — there is nothing left to prompt for.
 */
export interface SurveyStatus {
  survey: SurveyDefinition | null;
  completed: boolean;
}

/** Answers keyed by SurveyQuestion.id, submitted to POST /api/survey/:id/responses. */
export type SurveyAnswers = Record<string, string>;

/** Result of submitting a survey response — mirrors submit_survey_response()'s return values. */
export type SurveySubmitOutcome = 'applied' | 'duplicate' | 'survey_not_found';

/**
 * The Account page's editable profile, as returned by GET /api/me/profile.
 * Deliberately just contact/identity fields — trading behaviour (markets,
 * trader type, platform) lives in the survey, not here, so this never grows a
 * field the survey already asks for.
 */
export interface ProfileDetails {
  fullName: string | null;
  phoneNumber: string | null;
  profession: string | null;
  location: string | null;
  email: string;
  creditBalance: number;
  memberSince: string;
}

/**
 * Fields PATCH /api/me/profile accepts, all optional — only the ones present
 * are updated. An empty string clears a field; an absent key leaves it alone.
 */
/** The region GET /api/me resolves from the caller's IP for the current request. */
export interface SessionGeo {
  ip: string;
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
}

export interface ProfileUpdatePayload {
  fullName?: string;
  phoneNumber?: string;
  profession?: string;
  location?: string;
}

/** A market's session state, as returned by GET /api/market/status?market=. */
export interface MarketStatus {
  isOpen: boolean;
  message: string;
  /** ISO timestamp the status was read at, not when the market itself changed state. */
  asOf: string;
  /**
   * ISO timestamp of the next known state flip — today's close if open, or
   * today's open if still ahead of it. Null once there is no more of today's
   * session left to schedule against (already closed for the day, or the
   * exchange has no session today at all) — the caller falls back to
   * ordinary polling for those cases rather than guessing tomorrow's hours.
   */
  nextChangeAt: string | null;
}
