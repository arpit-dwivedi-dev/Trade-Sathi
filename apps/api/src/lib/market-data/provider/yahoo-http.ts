import { MarketDataError } from "../types.js";

/**
 * Shared HTTP plumbing for every Yahoo endpoint this codebase talks to.
 *
 * Extracted so the cookie/crumb pair has exactly ONE process-local cache. Two
 * modules each running their own handshake would double the traffic that
 * endpoint sees, and the handshake is the part Yahoo rate-limits hardest.
 * Subject to the same single-instance constraint as the candle cache — see
 * the operational note in CLAUDE.md.
 */

/**
 * Yahoo's endpoints 429 or 403 a fraction of requests with no User-Agent at
 * all; a plain browser-like UA is the documented community workaround, not a
 * spoofing/evasion measure. Shared by every request this module makes,
 * including the cookie/crumb handshake below, which is refused outright
 * without one.
 */
export const YAHOO_USER_AGENT = "Mozilla/5.0 (compatible; TradeSathi/1.0)";

/**
 * Node's fetch has no default timeout, and Yahoo under load soft-throttles by
 * stalling the connection rather than returning 429 — so an un-aborted request
 * can hang forever, taking the awaiting HTTP request or briefing job with it.
 * The endpoint answers in well under a second when healthy (~60ms warm), so a
 * few seconds is already far past "slow but working" and into "never coming".
 */
export const REQUEST_TIMEOUT_MS = 5_000;



/**
 * One GET against Yahoo, with the shared UA and timeout, and with connection
 * failures mapped to MarketDataError. The status is deliberately left to the
 * caller: each endpoint reads its own 401/404 differently (the chart endpoint
 * is unauthenticated, quoteSummary's 401 means a stale crumb).
 */
export async function fetchYahoo(url: string, instrumentKey: string, cookie?: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": YAHOO_USER_AGENT,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // A timeout is reported as its own thing rather than folded into the
    // generic failure text: it is the symptom of upstream throttling, and
    // the one these endpoints actually exhibit under load.
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new MarketDataError(
        "provider_error",
        `Yahoo Finance did not respond within ${REQUEST_TIMEOUT_MS}ms for symbol ${instrumentKey}`,
      );
    }
    throw new MarketDataError("provider_error", `Yahoo Finance request failed: ${String(cause)}`);
  }
}

/**
 * The response body as unstructured JSON, for a caller's schema to validate.
 * AbortSignal.timeout also aborts a stalled body stream, so a response whose
 * headers arrive promptly but whose body never completes fails here rather
 * than hanging.
 */
export async function readYahooJson(response: Response, instrumentKey: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new MarketDataError(
      "provider_error",
      `Yahoo Finance response for ${instrumentKey} was not valid JSON: ${String(cause)}`,
    );
  }
}

export const YAHOO_QUOTE_SUMMARY_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary";
export const YAHOO_TIMESERIES_URL =
  "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";
const YAHOO_COOKIE_URL = "https://fc.yahoo.com/";
const YAHOO_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";

/** Yahoo rejects a timeseries request without a window; this one spans every filing. */
export const TIMESERIES_PERIOD1 = 0;
export const TIMESERIES_PERIOD2 = 2_000_000_000;


/**
 * quoteSummary, unlike the chart endpoint, is cookie-and-crumb gated: without
 * both it answers 401 `Invalid Crumb` for every symbol. The pair is obtained
 * the same way a browser gets it — one request that only sets a consent
 * cookie, then one that trades that cookie for a crumb — and then reused for
 * every subsequent call rather than re-fetched per request, which would
 * triple the upstream traffic this endpoint sees.
 *
 * Process-local, like the candle cache, and subject to the same
 * single-instance constraint (see the operational note in CLAUDE.md).
 */
export interface CrumbSession {
  cookie: string;
  crumb: string;
  fetchedAt: number;
}

/**
 * Long enough that the pair is effectively per-process, short enough that a
 * rotated cookie is picked up without a restart. A 401 invalidates it
 * immediately regardless — see fetchQuoteSummary.
 */
const CRUMB_TTL_MS = 60 * 60_000;

let crumbSession: CrumbSession | null = null;
let crumbInFlight: Promise<CrumbSession> | null = null;

async function loadCrumbSession(): Promise<CrumbSession> {
  // The cookie request answers 404 — there is no page at that path, and there
  // does not need to be; the Set-Cookie header is the whole point of it, so
  // the status is deliberately not checked.
  let cookieResponse: Response;
  try {
    cookieResponse = await fetch(YAHOO_COOKIE_URL, {
      headers: { "User-Agent": YAHOO_USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new MarketDataError(
      "provider_error",
      `Yahoo Finance cookie request failed: ${String(cause)}`,
    );
  }

  const cookie = cookieResponse.headers
    .getSetCookie()
    .map((entry) => entry.split(";", 1)[0])
    .filter((pair) => pair.length > 0)
    .join("; ");

  if (!cookie) {
    throw new MarketDataError(
      "auth",
      "Yahoo Finance did not issue a cookie, so no crumb can be obtained",
    );
  }

  let crumbResponse: Response;
  try {
    crumbResponse = await fetch(YAHOO_CRUMB_URL, {
      headers: { "User-Agent": YAHOO_USER_AGENT, Cookie: cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new MarketDataError(
      "provider_error",
      `Yahoo Finance crumb request failed: ${String(cause)}`,
    );
  }

  if (!crumbResponse.ok) {
    throw new MarketDataError(
      "auth",
      `Yahoo Finance refused to issue a crumb (HTTP ${crumbResponse.status})`,
    );
  }

  const crumb = (await crumbResponse.text()).trim();
  // A blocked client gets a 200 with an HTML body rather than a crumb, so the
  // shape is checked and not just the status.
  if (!crumb || crumb.length > 64 || crumb.includes("<")) {
    throw new MarketDataError("auth", "Yahoo Finance returned no usable crumb");
  }

  return { cookie, crumb, fetchedAt: Date.now() };
}

/**
 * Drops the cached pair so the next call runs a fresh handshake. Yahoo can
 * rotate the cookie inside the TTL, and a stale pair then fails every call
 * until it expires — a 401 is the only signal that has happened.
 */
export function invalidateCrumbSession(): void {
  crumbSession = null;
}

/**
 * The cached pair, refreshed when stale and shared while in flight — the
 * same reasoning as the candle cache's collapsed misses: several concurrent
 * fundamentals requests on a cold process must not each run their own
 * two-request handshake.
 */
export async function getCrumbSession(): Promise<CrumbSession> {
  const session = crumbSession;
  if (session && Date.now() - session.fetchedAt < CRUMB_TTL_MS) return session;
  if (crumbInFlight) return crumbInFlight;

  crumbInFlight = loadCrumbSession()
    .then((loaded) => {
      crumbSession = loaded;
      return loaded;
    })
    .finally(() => {
      crumbInFlight = null;
    });

  return crumbInFlight;
}

/**
 * A sparsely populated numeric field. quoteSummary wraps every figure as
 * `{ raw, fmt }`, but which figures are present varies by company and by
 * market — a bank reports no gross margin, a loss-making company no trailing
 * P/E — and an absent one arrives either missing outright or as an empty
 * object `{}`. So the envelope below is validated by zod field-by-field, as
 * the chart response is, while the ~50 figures inside each module are read
 * through this: a strict per-field schema would reject a perfectly good
 * response because one ratio does not apply to the company asked about.
 */
export function readNumber(module: Record<string, unknown> | undefined, key: string): number | null {
  const field = module?.[key];
  if (typeof field === "number") return Number.isFinite(field) ? field : null;
  if (field !== null && typeof field === "object" && "raw" in field) {
    const { raw } = field;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

export function readString(module: Record<string, unknown> | undefined, key: string): string | null {
  const value = module?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** An epoch-seconds field (`regularMarketTime`, `mostRecentQuarter`) as an ISO string. */
export function readEpochSeconds(
  module: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const seconds = readNumber(module, key);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}
