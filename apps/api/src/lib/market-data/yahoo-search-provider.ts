import { z } from "zod";
import { logger } from "../logger.js";

const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Yahoo's own equity exchange codes for the two US markets this app exposes
 * as NASDAQ/NYSE. NMS/NGM/NCM are NASDAQ's three listing tiers (Global
 * Select, Global, Capital); NYQ is the NYSE. Only equities matter here —
 * ETFs/indices/crypto that Yahoo's search also returns are filtered out.
 */
const YAHOO_EXCHANGE_TO_MARKET: Record<string, "NASDAQ" | "NYSE"> = {
  NMS: "NASDAQ",
  NGM: "NASDAQ",
  NCM: "NASDAQ",
  NYQ: "NYSE",
};

const YahooSearchResponseSchema = z.object({
  quotes: z.array(
    z.object({
      symbol: z.string(),
      shortname: z.string().optional(),
      longname: z.string().optional(),
      exchange: z.string().optional(),
      quoteType: z.string().optional(),
    }),
  ),
});

export interface YahooSearchResult {
  exchange: "NASDAQ" | "NYSE";
  symbol: string;
  name: string;
}

/**
 * Live symbol search against Yahoo Finance's unofficial search endpoint —
 * used only for markets this app has no imported instrument catalogue for
 * (NASDAQ/NYSE today). Same trust level and failure handling as the chart
 * endpoint in yahoo-finance-provider.ts: no key/auth, best-effort, errors
 * are swallowed by the caller (an empty result is a normal "nothing typed
 * yet" outcome for autocomplete, not a page-breaking failure).
 */
export async function searchYahooSymbols(query: string): Promise<YahooSearchResult[]> {
  const url = `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; TradeSathi/1.0)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    logger.error("yahoo finance symbol search failed", { query, cause: String(cause) });
    return [];
  }

  if (!response.ok) {
    logger.error("yahoo finance symbol search returned an error status", {
      query,
      status: response.status,
    });
    return [];
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    logger.error("yahoo finance symbol search response was not valid JSON", {
      query,
      cause: String(cause),
    });
    return [];
  }

  const validation = YahooSearchResponseSchema.safeParse(body);
  if (!validation.success) {
    logger.error("yahoo finance symbol search response failed validation", { query });
    return [];
  }

  const results: YahooSearchResult[] = [];
  for (const quote of validation.data.quotes) {
    if (quote.quoteType !== "EQUITY") continue;
    const market = quote.exchange ? YAHOO_EXCHANGE_TO_MARKET[quote.exchange] : undefined;
    if (!market) continue;
    const name = quote.longname ?? quote.shortname;
    if (!name) continue;
    results.push({ exchange: market, symbol: quote.symbol, name });
  }
  return results;
}
