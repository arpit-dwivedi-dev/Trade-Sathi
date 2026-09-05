import { writeFileSync } from "node:fs";
import { getRawStatements } from "../../src/lib/market-data/provider/yahoo-statements.js";

/**
 * Regenerates the golden-set fixtures from the live upstream endpoints.
 *
 * Run by hand, never in CI: the golden set is deliberately frozen so the
 * suite is hermetic and does not drift every time a price moves. Re-run this
 * only when a fixture genuinely needs refreshing, and read the resulting
 * snapshot diff before committing it — a change there is a change in what the
 * pipeline reports, not noise.
 *
 *   npx tsx tests/tools/capture-fixtures.ts
 */

const TARGETS: { symbol: string; exchange: string; slug: string }[] = [
  { symbol: "TCS.NS", exchange: "NSE", slug: "tcs-nse" },
  { symbol: "NVDA", exchange: "NASDAQ", slug: "nvda-nasdaq" },
  { symbol: "JNJ", exchange: "NYSE", slug: "jnj-nyse" },
  { symbol: "AAPL", exchange: "NASDAQ", slug: "aapl-nasdaq-sept-fy" },
  { symbol: "WMT", exchange: "NYSE", slug: "wmt-nyse-jan-fy" },
  { symbol: "TSLA", exchange: "NASDAQ", slug: "tsla-no-dividend" },
  { symbol: "IDEA.NS", exchange: "NSE", slug: "idea-nse-lossmaker" },
  { symbol: "TRENT.BO", exchange: "BSE", slug: "trent-bse" },
  { symbol: "INFY.NS", exchange: "NSE", slug: "infy-nse" },
  { symbol: "RBLBANK.NS", exchange: "NSE", slug: "rblbank-nse" },
];

async function main(): Promise<void> {
  for (const t of TARGETS) {
    try {
      const statements = await getRawStatements(t.symbol);
      const path = new URL(`../golden/fixtures/${t.slug}.json`, import.meta.url);
      writeFileSync(path, JSON.stringify({ ...t, statements }, null, 2));
      console.log(
        `${t.slug.padEnd(26)} quarters=${statements.quarterly.length} annual=${statements.annual.length} cur=${statements.spot.financialCurrency}`,
      );
    } catch (cause) {
      console.log(`${t.slug.padEnd(26)} FAILED ${String(cause)}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
void main();
