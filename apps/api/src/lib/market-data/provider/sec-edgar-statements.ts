import { z } from "zod";
import { logger } from "../../logger.js";
import { reconstructMissingQuarters } from "../statement-reconstruction.js";
import type { RawPeriod, RawStatements } from "../statements.js";

/**
 * RAW quarterly/annual statements out of SEC EDGAR's free, public XBRL
 * Company Facts API — the official-filing source for US-listed instruments,
 * ahead of Yahoo in the fallback chain (see statements-merge.ts).
 *
 * Two calls: `company_tickers.json` maps a ticker to its CIK, then
 * `companyfacts/CIK##########.json` returns every XBRL fact the company has
 * ever tagged, across every 10-Q and 10-K. No API key; SEC's fair-use policy
 * asks only for a descriptive User-Agent.
 *
 * A concept like `Revenues` is tagged on EVERY filing that reports it,
 * including 6-/9-month year-to-date duration facts alongside the quarter-only
 * ones — so facts are classified by their OWN start/end span (roughly 90 days
 * for a quarter, roughly 365 for a year), never by which filing they came
 * from. Only genuinely quarter- or year-spanning facts are kept; anything
 * else (YTD, half-year) is discarded rather than guessed at.
 *
 * Returns null — never throws — when this source has nothing usable for the
 * symbol: not on EDGAR, network failure, or no quarterly facts found at all.
 * Yahoo remains the required fallback either way.
 */

const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
const COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts";
const SEC_USER_AGENT = "ChartAnalyzer fundamentals-fallback contact@chartanalyzer.app";
const REQUEST_TIMEOUT_MS = 8_000;

const TickerMapSchema = z.record(
  z.string(),
  z.object({ cik_str: z.number(), ticker: z.string(), title: z.string() }),
);

/** One duration or instant XBRL fact, as SEC reports it. */
const FactSchema = z.object({
  start: z.string().optional(),
  end: z.string(),
  val: z.number(),
  form: z.string(),
  filed: z.string(),
});
type Fact = z.infer<typeof FactSchema>;

const CompanyFactsSchema = z.object({
  facts: z.object({
    "us-gaap": z.record(z.string(), z.object({ units: z.record(z.string(), z.array(FactSchema.passthrough())) })).optional(),
    dei: z.record(z.string(), z.object({ units: z.record(z.string(), z.array(FactSchema.passthrough())) })).optional(),
  }),
});

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`SEC EDGAR returned HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

let tickerMapCache: { map: Map<string, number>; fetchedAt: number } | null = null;
let tickerMapInFlight: Promise<Map<string, number>> | null = null;
const TICKER_MAP_TTL_MS = 24 * 60 * 60_000;

/** Test-only: clears the in-process ticker-map cache so a test's mocked fetch is actually exercised. */
export function resetSecEdgarStatementCacheForTests(): void {
  tickerMapCache = null;
  tickerMapInFlight = null;
}

async function loadTickerMap(): Promise<Map<string, number>> {
  const cached = tickerMapCache;
  if (cached && Date.now() - cached.fetchedAt < TICKER_MAP_TTL_MS) return cached.map;
  if (tickerMapInFlight) return tickerMapInFlight;

  tickerMapInFlight = fetchJson(TICKER_MAP_URL)
    .then((json) => {
      const parsed = TickerMapSchema.parse(json);
      const map = new Map<string, number>();
      for (const entry of Object.values(parsed)) {
        map.set(entry.ticker.toUpperCase(), entry.cik_str);
      }
      tickerMapCache = { map, fetchedAt: Date.now() };
      return map;
    })
    .finally(() => {
      tickerMapInFlight = null;
    });

  return tickerMapInFlight;
}

function daysBetween(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** The same window derive-metrics.ts treats as one quarter apart. */
const MIN_QUARTER_SPAN_DAYS = 80;
/** A 16-week fiscal quarter is 112 days; see derive-metrics.ts. */
const MAX_QUARTER_SPAN_DAYS = 120;
const MIN_YEAR_SPAN_DAYS = 350;
const MAX_YEAR_SPAN_DAYS = 380;

/** Duration facts only, classified as quarterly (~90d) or annual (~365d). */
function classifyDuration(fact: Fact): 3 | 12 | null {
  if (!fact.start) return null;
  const days = daysBetween(fact.start, fact.end);
  if (days >= MIN_QUARTER_SPAN_DAYS && days <= MAX_QUARTER_SPAN_DAYS) return 3;
  if (days >= MIN_YEAR_SPAN_DAYS && days <= MAX_YEAR_SPAN_DAYS) return 12;
  return null;
}

/** Among facts landing on the same (start,end), the most authoritative one. */
function pickBest(candidates: Fact[], preferredForm: string): Fact {
  const sorted = [...candidates].sort((a, b) => {
    const aPreferred = a.form === preferredForm ? 1 : 0;
    const bPreferred = b.form === preferredForm ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    return b.filed.localeCompare(a.filed);
  });
  return sorted[0];
}

/** A restatement supersedes the original, so for one exact period the newest filing wins. */
function pickLatestFiled(a: Fact, b: Fact): Fact {
  return b.filed.localeCompare(a.filed) > 0 ? b : a;
}

/** One series value for one period end, plus the filing it is traceable to. */
interface Datum {
  value: number;
  filed: string | null;
  /** True when backed out of cumulative year-to-date facts rather than read directly. */
  derived?: boolean;
}

/** end -> best directly-reported fact of the requested cadence. */
function indexDurationFacts(facts: Fact[], months: 3 | 12): Map<string, Datum> {
  const byKey = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (classifyDuration(fact) !== months) continue;
    // An "annual" period is a FISCAL YEAR, filed as one in a 10-K — never a
    // trailing-twelve-months figure that happens to also span ~365 days.
    // Verified live on Amazon: its 2009-2010 era 10-Qs additionally tag
    // NetIncomeLoss with a TTM-as-of-that-quarter fact (e.g. 2008-07-01 to
    // 2009-06-30, filed inside a 10-Q for fiscal Q2 2010), landing squarely
    // in the annual span. Trusting any 365-day fact regardless of form
    // inflated Amazon's annual array from 18 real fiscal years to 74 entries,
    // most of them null-revenue TTM noise on quarter-end dates — exactly the
    // multi-year history the AI analysis prompt reads.
    if (months === 12 && !fact.form.startsWith("10-K")) continue;

    const key = `${fact.start}|${fact.end}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(fact);
    else byKey.set(key, [fact]);
  }
  const preferredForm = months === 3 ? "10-Q" : "10-K";
  const out = new Map<string, Datum>();
  for (const bucket of byKey.values()) {
    const chosen = pickBest(bucket, preferredForm);
    out.set(chosen.end, { value: chosen.val, filed: chosen.filed });
  }
  return out;
}

/**
 * Discrete quarters backed out of CUMULATIVE year-to-date facts.
 *
 * A US filer's 10-Q reports the cash flow statement year-to-date, not for the
 * quarter alone: verified against NVDA's live facts, `NetCashProvided...` for
 * fiscal 2026 arrives as 90d/181d/272d/363d spans from one fiscal-year start,
 * so only Q1 is ever a standalone quarter and Q2-Q4 exist only inside a
 * running total. Differencing consecutive links of that chain — Q2 = YTD6 −
 * Q1, Q3 = YTD9 − YTD6, Q4 = FY − YTD9 — recovers the discrete quarter
 * exactly. Without it, operating cash flow, capex and dividends paid can
 * never reach the four contiguous quarters a TTM needs, and free cash flow is
 * unreportable no matter how many quarters of revenue are available.
 *
 * Same source, same basis, same filer, same fiscal year, exact arithmetic —
 * the identical methodology statement-reconstruction.ts already applies to a
 * missing quarter, just along the other axis.
 *
 * ONLY VALID FOR ADDITIVE FLOW LINES. A weighted-average share count is not
 * additive across quarters, so differencing its year-to-date value produces a
 * meaningless number; callers pass `additive: false` for those.
 */
function indexYtdDifferences(facts: Fact[]): Map<string, Datum> {
  const byStart = new Map<string, Map<string, Fact>>();
  for (const fact of facts) {
    if (!fact.start) continue;
    const span = daysBetween(fact.start, fact.end);
    // Cumulative spans within a single fiscal year only: one quarter up to one year.
    if (span < MIN_QUARTER_SPAN_DAYS || span > MAX_YEAR_SPAN_DAYS) continue;
    let chain = byStart.get(fact.start);
    if (!chain) {
      chain = new Map();
      byStart.set(fact.start, chain);
    }
    const existing = chain.get(fact.end);
    chain.set(fact.end, existing ? pickLatestFiled(existing, fact) : fact);
  }

  const out = new Map<string, Datum>();
  for (const chain of byStart.values()) {
    const links = [...chain.values()].sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < links.length; i++) {
      const previous = links[i - 1];
      const current = links[i];
      const span = daysBetween(previous.end, current.end);
      if (span < MIN_QUARTER_SPAN_DAYS || span > MAX_QUARTER_SPAN_DAYS) continue;
      out.set(current.end, { value: current.val - previous.val, filed: current.filed, derived: true });
    }
  }
  return out;
}

/** end -> best instant fact (balance-sheet-style point-in-time figures). */
function indexInstantFacts(facts: Fact[]): Map<string, Datum> {
  const byEnd = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.start) continue; // duration fact, not instant
    const bucket = byEnd.get(fact.end);
    if (bucket) bucket.push(fact);
    else byEnd.set(fact.end, [fact]);
  }
  const out = new Map<string, Datum>();
  for (const [end, bucket] of byEnd) {
    const chosen = pickBest(bucket, "10-K");
    out.set(end, { value: chosen.val, filed: chosen.filed });
  }
  return out;
}

type GaapFacts = Record<string, { units: Record<string, Fact[]> }>;

/**
 * One concept's facts in one unit. The unit is NOT always USD: a share count
 * is filed under "shares" and was silently read as empty while this defaulted
 * to USD, which is why diluted shares — and every metric derived from it,
 * trailing EPS and trailing P/E included — came back missing for every
 * US-listed instrument.
 */
function conceptFacts(facts: GaapFacts | undefined, concept: string, unit: string): Fact[] {
  return facts?.[concept]?.units?.[unit] ?? [];
}

/** Definition of one statement line: the concepts that may carry it, and how. */
interface LineSpec {
  concepts: string[];
  unit: string;
  /** False for non-additive lines (weighted averages), which are never differenced. */
  additive: boolean;
}

/**
 * Merges a line's series across ALL of its candidate concepts, earlier
 * concepts winning a contested period end.
 *
 * Deliberately not "the first concept that has any facts at all": a filer
 * changes the tag it reports a line under between taxonomy versions, so one
 * concept covers the early years and another the recent ones. NVDA reports
 * capex as `PaymentsToAcquirePropertyPlantAndEquipment` historically and
 * `PaymentsToAcquireProductiveAssets` in current filings — first-concept-wins
 * returned the stale series and dropped every recent quarter.
 */
function durationSeries(facts: GaapFacts | undefined, spec: LineSpec, months: 3 | 12): Map<string, Datum> {
  const merged = new Map<string, Datum>();
  for (const concept of spec.concepts) {
    const conceptSeries = conceptFacts(facts, concept, spec.unit);
    const direct = indexDurationFacts(conceptSeries, months);
    // A directly reported quarter always beats one backed out of a running total.
    const derived = months === 3 && spec.additive ? indexYtdDifferences(conceptSeries) : new Map<string, Datum>();
    for (const [end, datum] of [...derived, ...direct]) {
      if (!merged.has(end)) merged.set(end, datum);
    }
  }
  return merged;
}

function instantSeries(facts: GaapFacts | undefined, spec: LineSpec): Map<string, Datum> {
  const merged = new Map<string, Datum>();
  for (const concept of spec.concepts) {
    for (const [end, datum] of indexInstantFacts(conceptFacts(facts, concept, spec.unit))) {
      if (!merged.has(end)) merged.set(end, datum);
    }
  }
  return merged;
}

const USD = (concepts: string[]): LineSpec => ({ concepts, unit: "USD", additive: true });

const REVENUE = USD([
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
]);
const COST_OF_REVENUE = USD(["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"]);
const GROSS_PROFIT = USD(["GrossProfit"]);
const OPERATING_INCOME = USD(["OperatingIncomeLoss"]);
const PRETAX_INCOME = USD([
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
]);
/**
 * Only ever added back to net income to recover a pretax figure the filer
 * stopped tagging. Costco reports income tax expense every quarter through
 * the current one and last tagged a pretax subtotal in May 2024; Procter &
 * Gamble has never tagged a quarterly one at all. Pretax income and the
 * implied tax rate were missing for both, out of statements that state the
 * tax charge outright.
 */
const INCOME_TAX = USD(["IncomeTaxExpenseBenefit"]);
const NET_INCOME = USD(["NetIncomeLoss", "ProfitLoss"]);
/** A weighted average, so never differenced out of a year-to-date figure. */
const DILUTED_SHARES: LineSpec = {
  concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  unit: "shares",
  additive: false,
};
const OPERATING_CASH_FLOW = USD(["NetCashProvidedByUsedInOperatingActivities"]);
const CAPEX = USD(["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]);
const DIVIDENDS_PAID = USD(["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]);
/**
 * Parent-only equity first, then the version including non-controlling
 * interests. The second is not a nicety: Procter & Gamble tags
 * `StockholdersEquity` nowhere in its entire filing history, so equity — and
 * with it return on equity — came back missing for a company that reports a
 * balance sheet every quarter.
 */
const EQUITY = USD([
  "StockholdersEquity",
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
]);
const CASH = USD([
  "CashAndCashEquivalentsAtCarryingValue",
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
]);
const LONG_TERM_DEBT = USD(["LongTermDebtNoncurrent", "LongTermDebt"]);
const CURRENT_DEBT = USD(["LongTermDebtCurrent"]);
const SHARES_OUTSTANDING: LineSpec = {
  concepts: ["EntityCommonStockSharesOutstanding"],
  unit: "shares",
  additive: false,
};

function buildPeriods(gaap: GaapFacts | undefined, dei: GaapFacts | undefined, months: 3 | 12): RawPeriod[] {
  const revenue = durationSeries(gaap, REVENUE, months);
  const costOfRevenue = durationSeries(gaap, COST_OF_REVENUE, months);
  const grossProfit = durationSeries(gaap, GROSS_PROFIT, months);
  const operatingIncome = durationSeries(gaap, OPERATING_INCOME, months);
  const pretaxIncome = durationSeries(gaap, PRETAX_INCOME, months);
  const netIncome = durationSeries(gaap, NET_INCOME, months);
  const incomeTax = durationSeries(gaap, INCOME_TAX, months);
  const dilutedShares = durationSeries(gaap, DILUTED_SHARES, months);
  const operatingCashFlow = durationSeries(gaap, OPERATING_CASH_FLOW, months);
  const capex = durationSeries(gaap, CAPEX, months);
  const dividendsPaid = durationSeries(gaap, DIVIDENDS_PAID, months);

  const equity = instantSeries(gaap, EQUITY);
  const cash = instantSeries(gaap, CASH);
  const longTermDebt = instantSeries(gaap, LONG_TERM_DEBT);
  const currentDebt = instantSeries(gaap, CURRENT_DEBT);
  const sharesOutstanding = instantSeries(dei, SHARES_OUTSTANDING);

  const value = (series: Map<string, Datum>, end: string): number | null => series.get(end)?.value ?? null;
  /** Providers file an outflow as a negative; downstream wants a positive magnitude. */
  const magnitude = (series: Map<string, Datum>, end: string): number | null => {
    const raw = value(series, end);
    return raw === null ? null : Math.abs(raw);
  };

  const ends = new Set<string>();
  for (const series of [revenue, netIncome, operatingIncome, pretaxIncome, costOfRevenue, grossProfit]) {
    for (const end of series.keys()) ends.add(end);
  }

  const periods: RawPeriod[] = [];
  for (const end of ends) {
    // The line that establishes the period at all also establishes its provenance:
    // a Q4 that exists only as (fiscal year − year-to-date-through-Q3) is a
    // derived period and is recorded as one, exactly as a period filled by
    // statement-reconstruction.ts is.
    const primary = revenue.get(end) ?? netIncome.get(end) ?? operatingIncome.get(end);
    const filingDate = primary?.filed ?? null;
    const revenueValue = value(revenue, end);

    const longTerm = value(longTermDebt, end);
    const current = value(currentDebt, end);
    const totalDebt = longTerm !== null || current !== null ? (longTerm ?? 0) + (current ?? 0) : null;

    // Pretax income, from the subtotal where the filer tags one and from the
    // identity (net income + tax charge) where it does not. Both figures come
    // from the same filing for the same period, so this restates that
    // filing's own arithmetic rather than combining anything.
    const netIncomeValue = value(netIncome, end);
    const taxValue = value(incomeTax, end);
    const pretaxValue =
      value(pretaxIncome, end) ??
      (netIncomeValue !== null && taxValue !== null ? netIncomeValue + taxValue : null);

    periods.push({
      periodEnd: end,
      months,
      basis: "consolidated",
      currency: "USD",
      source: "sec-edgar",
      filingDate,
      revenue: revenueValue,
      totalIncome: revenueValue,
      otherIncome: null,
      costOfRevenue: value(costOfRevenue, end),
      grossProfit: value(grossProfit, end),
      operatingIncome: value(operatingIncome, end),
      pretaxIncome: pretaxValue,
      netIncome: netIncomeValue,
      dilutedShares: value(dilutedShares, end),
      operatingCashFlow: value(operatingCashFlow, end),
      capex: magnitude(capex, end),
      dividendsPaid: magnitude(dividendsPaid, end),
      equity: value(equity, end),
      totalDebt,
      cash: value(cash, end),
      sharesOutstanding: value(sharesOutstanding, end),
      ...(primary?.derived ? { reconstructed: true } : {}),
    });
  }

  return periods.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

export async function getSecEdgarStatements(symbol: string): Promise<RawStatements | null> {
  try {
    const tickerMap = await loadTickerMap();
    const cik = tickerMap.get(symbol.toUpperCase());
    if (cik === undefined) {
      logger.info("sec edgar has no CIK for symbol", { symbol });
      return null;
    }

    const paddedCik = String(cik).padStart(10, "0");
    const json = await fetchJson(`${COMPANY_FACTS_URL}/CIK${paddedCik}.json`);
    const parsed = CompanyFactsSchema.parse(json);

    const gaap = parsed.facts["us-gaap"];
    const dei = parsed.facts.dei;

    const quarterlyRaw = buildPeriods(gaap, dei, 3);
    const annual = buildPeriods(gaap, dei, 12);

    if (quarterlyRaw.length === 0) {
      logger.info("sec edgar has no quarterly facts for symbol", { symbol });
      return null;
    }

    const quarterly = reconstructMissingQuarters(quarterlyRaw, annual);

    return {
      quarterly,
      annual,
      spot: {
        price: null,
        asOf: null,
        marketCap: null,
        currency: null,
        financialCurrency: null,
        dividendDeclaredPerShare: null,
        dividendYield: null,
        mostRecentQuarter: null,
      },
      forward: [],
      corporateActions: null,
    };
  } catch (cause) {
    logger.warn("sec edgar statements unavailable", { symbol, cause: String(cause) });
    return null;
  }
}
