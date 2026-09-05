import type { SourceTier } from "../verification/types.js";

/**
 * Host classification for web search results.
 *
 * Extracted from the fundamentals verification service so the news-analysis
 * feature can reuse it. Deliberately domain-agnostic about WHAT is being
 * searched for — it only answers "how much weight does this host carry".
 */

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
