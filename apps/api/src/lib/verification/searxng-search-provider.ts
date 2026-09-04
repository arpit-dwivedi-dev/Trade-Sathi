import { logger } from "../logger.js";
import type { SearchProvider, SearchResult, Source, SourceTier } from "./types.js";

/**
 * Domain allowlist used to classify a search hit's tier. Deliberately a
 * plain array checked by suffix match, not a config file: the set of
 * authoritative/secondary domains for Indian- and US-listed fundamentals is
 * small and changes rarely, and keeping it here next to the provider that
 * consumes it is easier to audit than a separate config surface.
 *
 * Tier1 — official/primary: exchanges and the regulator. Company IR/investor
 * pages are also tier1 but cannot be enumerated in advance; those are
 * classified by the caller matching a known company domain (see
 * classifyHost's companyDomains parameter), not by this list.
 * Tier2 — reliable secondary: aggregators that reproduce or derive from
 * exchange/company filings.
 * Everything else falls through to tier3 — this deliberately excludes
 * finance.yahoo.com: it is the same provider InstrumentFundamentals already
 * comes from, so a hit from it would corroborate Yahoo's own number against
 * itself rather than against an independent source.
 */
const TIER1_DOMAINS = [
  // India: exchanges and the regulator.
  "nseindia.com",
  "bseindia.com",
  "sebi.gov.in",
  // US: exchanges and the regulator's own filings database.
  "sec.gov",
  "nasdaq.com",
  "nyse.com",
];

const TIER2_DOMAINS = [
  // India
  "screener.in",
  "moneycontrol.com",
  "tickertape.in",
  "morningstar.in",
  "marketsmojo.com",
  "trendlyne.com",
  "groww.in",
  // US (morningstar.com and wsj.com also carry India/global coverage, kept
  // once each rather than duplicated per market)
  "morningstar.com",
  "stockanalysis.com",
  "macrotrends.net",
  "wsj.com",
  "marketwatch.com",
];

/**
 * Classifies a URL's host into a SourceTier. `companyDomains` lets a caller
 * that knows the instrument's own IR domain (InstrumentFundamentals'
 * profile.website) promote it to tier1 for this lookup, without hardcoding
 * every listed company's domain here.
 */
export function classifyHost(url: string, companyDomains: string[] = []): SourceTier {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "tier3";
  }

  const matchesAny = (domains: string[]) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

  if (matchesAny(TIER1_DOMAINS) || matchesAny(companyDomains)) return "tier1";
  if (matchesAny(TIER2_DOMAINS)) return "tier2";
  return "tier3";
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

interface SearxngResultRow {
  url?: unknown;
  title?: unknown;
  content?: unknown;
}

interface SearxngResponse {
  results?: SearxngResultRow[];
}

/**
 * SearchProvider backed by a self-hosted SearXNG instance's JSON API
 * (`GET {baseUrl}/search?q=...&format=json`). Kept independent of
 * VerificationEngine per the verification-layer design: it only answers
 * "what did the web say", classification and extraction happen in the
 * engine. A future second provider (a paid financial-data search API, for
 * instance) can implement the same SearchProvider interface without any
 * change to the engine.
 */
export class SearxngSearchProvider implements SearchProvider {
  readonly name = "searxng";

  constructor(
    private readonly baseUrl: string | null,
    /** Known IR/company domains to promote to tier1 for this instrument,
     *  e.g. from InstrumentFundamentals.profile.website. */
    private readonly companyDomains: string[] = [],
    private readonly timeoutMs = 8_000,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.baseUrl) return [];

    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        logger.warn("searxng search returned a non-ok status", {
          status: response.status,
          query,
        });
        return [];
      }

      const body = (await response.json()) as SearxngResponse;
      const rows = Array.isArray(body.results) ? body.results : [];

      const results: SearchResult[] = [];
      for (const row of rows) {
        if (typeof row.url !== "string") continue;
        const source: Source = {
          tier: classifyHost(row.url, this.companyDomains),
          name: hostLabel(row.url),
          url: row.url,
        };
        results.push({
          source,
          title: typeof row.title === "string" ? row.title : "",
          snippet: typeof row.content === "string" ? row.content : "",
        });
      }
      return results;
    } catch (cause) {
      logger.warn("searxng search failed", { query, cause: String(cause) });
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
