import type { MarketCode } from "@tradesathi/shared";
import { logger } from "../lib/logger.js";

/**
 * Free, keyless NSE/BSE logo directory keyed directly by exchange + ticker —
 * no domain-guessing involved, and a genuine 404 (GitHub Pages) when a
 * symbol has no logo, unlike a favicon-style service that always 200s with a
 * generic placeholder. See https://github.com/dharunashokkumar/indian-listed-company-logos.
 */
const INDIAN_LOGO_MARKETS = new Set<MarketCode>(["NSE", "BSE"]);

function indianLogoUrl(market: MarketCode, symbol: string): string {
  const exchange = market.toLowerCase();
  return `https://dharunashokkumar.github.io/indian-listed-company-logos/${exchange}/${market}_${symbol}.svg`;
}

/**
 * Logo.dev's ticker endpoint, for markets the keyless NSE/BSE directory
 * doesn't cover (NASDAQ/NYSE) and as a fallback for NSE/BSE symbols missing
 * from it. `fallback=404` turns off its default behaviour of always
 * returning a 200 monogram placeholder — without it, a miss would look
 * identical to a hit and every unmatched symbol would get cached as "found".
 */
function logoDevUrl(symbol: string, publishableKey: string): string {
  return `https://img.logo.dev/ticker/${symbol}?token=${publishableKey}&fallback=404`;
}

/** True if the URL resolves to an actual image, not a 404/error page. */
async function urlServesImage(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.startsWith("image/");
  } catch (cause) {
    logger.error("logo lookup request failed", { url, cause: String(cause) });
    return false;
  }
}

/**
 * Resolves a company logo for one instrument, trying the free NSE/BSE
 * directory first (only relevant for those two markets) and falling back to
 * Logo.dev. Callers persist the result (including a null) against the
 * instrument row so this only ever runs once per symbol — see
 * instruments.service.ts.
 */
export async function resolveInstrumentLogo(
  market: MarketCode,
  symbol: string,
): Promise<string | null> {
  if (INDIAN_LOGO_MARKETS.has(market)) {
    const candidate = indianLogoUrl(market, symbol);
    if (await urlServesImage(candidate)) return candidate;
  }

  const publishableKey = process.env["LOGO_DEV_PUBLISHABLE_KEY"];
  if (!publishableKey) return null;

  const candidate = logoDevUrl(symbol, publishableKey);
  return (await urlServesImage(candidate)) ? candidate : null;
}
