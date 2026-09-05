import { logger } from "../logger.js";
import type { SearchProvider, SearchResult, Source } from "../verification/types.js";
import { classifyHost } from "./classify-host.js";

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
