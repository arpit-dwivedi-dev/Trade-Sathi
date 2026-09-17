/**
 * Old pipeline vs new, on the same instrument at the same moment.
 *
 * Run by hand:  npx tsx tests/tools/rerun-diff.ts
 *
 * LEFT is what the previous prompt consumed: the provider's own pre-computed
 * convenience fields, unlabelled. RIGHT is what the derivation layer now
 * produces from raw statements, with the period each figure belongs to.
 */
import { YahooFinanceMarketDataProvider } from "../../src/lib/market-data/provider/yahoo-finance-provider.js";
import { getRawStatements } from "../../src/lib/market-data/provider/yahoo-statements.js";
import { deriveFundamentals } from "../../src/services/fundamentals/index.js";
import { formatAmount, formatPercent } from "../../src/services/fundamentals/display.js";
import type { DerivedMetricKey } from "@tradesathi/shared";

const provider = new YahooFinanceMarketDataProvider();

const ROWS: { label: string; old: string; now: DerivedMetricKey | null }[] = [
  { label: "revenue growth", old: "growth.revenueGrowth", now: "revenueGrowth" },
  { label: "  (fiscal year)", old: "—", now: "revenueGrowthFy" },
  { label: "earnings growth", old: "growth.earningsGrowth", now: "earningsGrowth" },
  { label: "  (fiscal year)", old: "—", now: "earningsGrowthFy" },
  { label: "operating margin", old: "profitability.operatingMargin", now: "operatingMargin" },
  { label: "net margin", old: "profitability.profitMargin", now: "netMargin" },
  { label: "gross margin", old: "profitability.grossMargin", now: "grossMargin" },
  { label: "return on equity", old: "profitability.returnOnEquity", now: "roe" },
  { label: "operating cash flow", old: "health.operatingCashflow", now: "operatingCashFlow" },
  { label: "capex", old: "—", now: "capex" },
  { label: "free cash flow", old: "health.freeCashflow", now: "fcf" },
  { label: "total debt", old: "health.totalDebt", now: "totalDebt" },
  { label: "trailing P/E", old: "valuation.trailingPe", now: "trailingPe" },
  { label: "forward P/E", old: "valuation.forwardPe", now: "forwardPe" },
  { label: "payout ratio", old: "valuation.payoutRatio", now: "payoutRatioCash" },
  { label: "  (declared)", old: "—", now: "payoutRatioDeclared" },
];

function readPath(obj: unknown, path: string): number | null {
  if (path === "—") return null;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "number" ? cur : null;
}

const PERCENTS = new Set([
  "revenueGrowth", "revenueGrowthFy", "earningsGrowth", "earningsGrowthFy",
  "operatingMargin", "netMargin", "grossMargin", "roe",
  "payoutRatioCash", "payoutRatioDeclared",
]);

async function main(): Promise<void> {
  for (const [symbol, exchange] of [["TCS.NS", "NSE"], ["NVDA", "NASDAQ"]] as const) {
    const [legacy, statements] = await Promise.all([
      provider.getFundamentals(symbol),
      getRawStatements(symbol),
    ]);
    const derived = deriveFundamentals(statements, exchange);
    const { metrics, facts, profile, dataNotes } = derived;

    console.log(`\n${"=".repeat(104)}`);
    console.log(`${symbol}  —  fiscal year ends month ${profile.fiscalYearEndMonth}, ${profile.reportingCurrency}, read in ${profile.displayUnit}`);
    console.log("=".repeat(104));
    console.log(
      `${"metric".padEnd(20)}${"OLD (provider field, no period)".padEnd(26)}${"NEW (derived)".padEnd(20)}period`,
    );
    console.log("-".repeat(104));

    for (const row of ROWS) {
      const oldValue = readPath(legacy, row.old);
      const metric = row.now ? metrics[row.now] : null;
      const isPercent = row.now !== null && PERCENTS.has(row.now);

      const oldText =
        row.old === "—" ? "(not produced)" : oldValue === null ? "null" : isPercent ? formatPercent(oldValue) : fmt(oldValue);
      const newText =
        metric === null || metric.value === null
          ? metric?.reliability === "missing" ? "MISSING" : "—"
          : isPercent
            ? formatPercent(metric.value)
            : fmt(metric.value);

      const flag = metric?.reliability === "unreliable" ? " !" : "";
      console.log(
        `${row.label.padEnd(20)}${oldText.padEnd(26)}${(newText + flag).padEnd(20)}${metric?.period ?? ""}`,
      );
    }

    function fmt(value: number): string {
      if (Math.abs(value) > 1e6) return formatAmount(value, profile);
      return String(Number(value.toPrecision(6)));
    }

    console.log("-".repeat(104));
    console.log("PRE-COMPUTED FACTS handed to the prompt (the model no longer derives these):");
    console.log(`  leverage band            ${facts.leverageBand}`);
    console.log(`  growth supports earnings ${facts.growthSupportsEarnings}`);
    console.log(`  dividend sustainability  ${facts.dividendSustainability}`);
    console.log(`  valuation read           ${facts.valuationRead}`);
    console.log(`  cash conversion          ${facts.cashConversion ?? "—"}`);
    console.log(`  thresholds               ${JSON.stringify(facts.thresholds)}`);
    console.log(`DATA NOTES (${dataNotes.length}):`);
    for (const n of dataNotes) console.log(`  [${n.severity}] ${n.title}`);
  }
}
void main();
