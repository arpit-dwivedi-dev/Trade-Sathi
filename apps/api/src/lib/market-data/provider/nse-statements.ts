import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { RawCorporateAction, RawPeriod, RawStatements } from "../statements.js";

/**
 * RAW quarterly statements out of NSE's public (unofficial, but reachable
 * with a plain browser User-Agent — no cookie/crumb dance was needed against
 * the live endpoint) corporate-filing feeds — the official-filing source for
 * NSE/BSE instruments, ahead of Yahoo in the fallback chain (see
 * statements-merge.ts).
 *
 * TWO FEEDS, ONE HISTORY
 *
 * SEBI replaced the standalone quarterly results filing with a combined
 * "Integrated Filing (Financials)" from the quarter ending 31 March 2025.
 * NSE serves the two under different endpoints, in different taxonomies, and
 * the older endpoint simply stops at 31 December 2024 — so reading it alone
 * leaves every Indian company twenty-one months short at the recent end of
 * its history, which is the end every trailing metric is computed from. Both
 * are read and their filings combined.
 *
 * Either endpoint returns metadata only (period boundaries, whether the
 * filing is consolidated/standalone, a link to the actual Ind-AS XBRL). The
 * figures themselves live in that linked XBRL document.
 *
 * XBRL CONTEXT DATES ARE NOT TRUSTWORTHY
 *
 * Verified against a live TCS filing: the XBRL declares a "FourD" context
 * (its value is clearly a 9-month year-to-date figure, ~3x the quarter) with
 * the SAME start/end dates as "OneD" (the quarter itself) — the filer's XBRL
 * software mislabelled it. So only the "OneD" context is ever read, and only
 * after confirming its OWN declared start/end matches the results-endpoint
 * row's fromDate/toDate exactly. A filing whose OneD dates don't match is
 * skipped outright rather than risking a mislabelled period — the same
 * defect this codebase's fundamentals rebuild already paid for once (see
 * fundamentals-derived.ts).
 *
 * WHAT AN INDIAN FILING ACTUALLY CONTAINS
 *
 * A plain quarterly filing carries the P&L, EPS and share capital. The
 * HALF-YEARLY ones — the quarters ending 30 September and 31 March — add a
 * full balance sheet, tagged at an instant, and a year-to-date cash flow
 * statement. That is the whole of what SEBI requires, and it is why cash-flow
 * figures never appear at quarterly cadence for an Indian company from any
 * source: nobody files them.
 *
 * Returns null — never throws — when this source has nothing usable: no
 * results for the symbol, network failure, or no filing survives the
 * cross-check above. Yahoo remains the required fallback either way.
 */

/**
 * The pre-2025 feed. SEBI replaced standalone results filings with a combined
 * "Integrated Filing (Financials)" from the quarter ending 31 March 2025, and
 * this endpoint was frozen at that boundary rather than retired: verified
 * live against RELIANCE, TCS, HDFCBANK and MARUTI, every one of which returns
 * nothing later than 31 December 2024 here, and its own filings up to the
 * current quarter under INTEGRATED_URL below.
 *
 * Both are read and their filings combined. This one alone leaves a
 * twenty-one-month hole at the RECENT end of every Indian company's history —
 * exactly the end every trailing metric is computed from.
 */
const RESULTS_URL = "https://www.nseindia.com/api/corporates-financial-results";
/** The post-2025 feed. Same figures, new SEBI taxonomy — see PREFIXES. */
const INTEGRATED_URL = "https://www.nseindia.com/api/integrated-filing-results";
const INTEGRATED_REFERER =
  "https://www.nseindia.com/companies-listing/corporate-filings-financial-results";
const HOME_URL = "https://www.nseindia.com/";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FILINGS = 20;

const ResultRowSchema = z.object({
  symbol: z.string(),
  consolidated: z.string(),
  cumulative: z.string(),
  format: z.string(),
  fromDate: z.string(),
  toDate: z.string(),
  filingDate: z.string(),
  xbrl: z.string().nullable(),
});

const IntegratedRowSchema = z.object({
  symbol: z.string(),
  /** "Consolidated" | "Standalone" | null (null on the governance filing). */
  consolidated: z.string().nullable(),
  /** "Integrated Filing- Financials" | "Integrated Filing- Governance". */
  type: z.string(),
  /** Quarter end, "30-JUN-2026". */
  qe_Date: z.string(),
  xbrl: z.string().nullable(),
  broadcast_Date: z.string().nullable(),
});

/**
 * One filing to read, normalised across the two feeds.
 *
 * Dates are ISO here and nowhere else in this module deals with NSE's
 * "30-JUN-2026" form: the two endpoints disagree on both the field names and
 * the capitalisation of the month, and the old feed's fromDate/toDate pair
 * has no counterpart in the new one at all.
 */
interface FilingRef {
  symbol: string;
  consolidated: boolean;
  periodStart: string;
  periodEnd: string;
  filingDate: string | null;
  xbrl: string;
}

async function fetchWithSession(url: string, referer?: string): Promise<Response> {
  const attempt = async (cookie?: string) =>
    fetch(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "application/json",
        ...(referer ? { Referer: referer } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let response = await attempt();
  if (response.status === 401 || response.status === 403) {
    const home = await fetch(HOME_URL, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const cookie = home.headers
      .getSetCookie()
      .map((entry) => entry.split(";", 1)[0])
      .filter((pair) => pair.length > 0)
      .join("; ");
    if (cookie) response = await attempt(cookie);
  }
  return response;
}

/** "01-Oct-2024" -> "2024-10-01". Month case is not consistent between the
 *  two feeds ("30-JUN-2026" in the integrated one), so it is normalised. */
function parseNseDate(value: string): string | null {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(value);
  if (!match) return null;
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const month = months[match[2][0].toUpperCase() + match[2].slice(1).toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1]}`;
}

/**
 * The first day of the quarter ending on `periodEnd`.
 *
 * Only ever applied to the integrated feed, which reports a quarter end and
 * no start. Indian quarterly results are strictly calendar-aligned
 * (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar) — there is no 52/53-week filer here —
 * and the derived start is checked against the filing's own declared context
 * before any figure is read from it.
 */
function quarterStartOf(periodEnd: string): string {
  const [year, month] = periodEnd.split("-").map(Number);
  const startMonth = month - 2;
  return startMonth > 0
    ? `${year}-${String(startMonth).padStart(2, "0")}-01`
    : `${year - 1}-${String(startMonth + 12).padStart(2, "0")}-01`;
}

function daysBetween(startIso: string, endIso: string): number {
  const a = new Date(`${startIso}T00:00:00Z`).getTime();
  const b = new Date(`${endIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

const ACTIONS_URL = "https://www.nseindia.com/api/corporates-corporateActions";
const ACTIONS_REFERER = "https://www.nseindia.com/companies-listing/corporate-filings-actions";

/**
 * How far back a corporate action still explains a share-count move.
 *
 * The plausibility rule this feeds compares the latest quarter's share count
 * against the one four quarters earlier, so only an action inside that span
 * can account for a jump between them. An older split left in the list would
 * suppress the rule permanently for any company that ever split.
 */
const ACTION_WINDOW_DAYS = 400;

const ActionRowSchema = z.object({
  /** "Bonus 1:1", "Face Value Split From Rs.10 To Re.1", "Dividend - Rs 4 Per Share". */
  subject: z.string().nullable(),
  exDate: z.string().nullable(),
});

/**
 * Splits, bonus issues and buybacks from NSE's corporate-actions feed.
 *
 * The ONLY corporate-action feed this pipeline has: Yahoo supplies none at
 * all, so before this every Indian company's share count moved unexplained
 * and the plausibility gate — correctly, on what it knew — marked diluted
 * shares and every per-share figure unreliable. HDFC Bank's 1:1 bonus of
 * August 2025 and Trent's 1:2 of June 2026 both doubled or halved a share
 * count with nothing on record to account for it.
 *
 * Best-effort: a failure returns null, which is "could not check" and is
 * exactly what the gate already handles.
 */
async function fetchCorporateActions(symbol: string): Promise<RawCorporateAction[] | null> {
  try {
    const url = `${ACTIONS_URL}?index=equities&symbol=${encodeURIComponent(symbol)}`;
    const response = await fetchWithSession(url, ACTIONS_REFERER);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json: unknown = await response.json();
    const rows = z.array(ActionRowSchema.passthrough()).parse(json);

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - ACTION_WINDOW_DAYS);
    const earliest = cutoff.toISOString().slice(0, 10);

    const actions: RawCorporateAction[] = [];
    for (const row of rows) {
      const date = row.exDate === null ? null : parseNseDate(row.exDate);
      if (!date || date < earliest || row.subject === null) continue;
      const action = classifyAction(row.subject, date);
      if (action) actions.push(action);
    }
    return actions;
  } catch (cause) {
    logger.warn("nse corporate actions unavailable", { symbol, cause: String(cause) });
    return null;
  }
}

/** Reads one action's subject line. Returns null for anything but a split, bonus or buyback. */
function classifyAction(subject: string, date: string): RawCorporateAction | null {
  const text = subject.toLowerCase();

  // "Bonus 1:2" — one new share for every two held, so 1.5 shares per old one.
  const bonus = /bonus[^\d]*(\d+)\s*:\s*(\d+)/.exec(text);
  if (bonus) {
    const [newShares, held] = [Number(bonus[1]), Number(bonus[2])];
    return { kind: "bonus", date, ratio: held === 0 ? null : (newShares + held) / held };
  }

  // "Face Value Split From Rs.10 To Re.1" — ten shares where there was one.
  if (text.includes("split")) {
    const split = /from\s*rs?\.?\s*([\d.]+)\s*(?:\/-)?\s*to\s*rs?e?\.?\s*([\d.]+)/.exec(text);
    const [from, to] = split ? [Number(split[1]), Number(split[2])] : [NaN, NaN];
    return {
      kind: "split",
      date,
      ratio: Number.isFinite(from) && Number.isFinite(to) && to !== 0 ? from / to : null,
    };
  }

  if (text.includes("buy back") || text.includes("buyback")) {
    return { kind: "buyback", date, ratio: null };
  }
  return null;
}

/** The pre-2025 feed's rows, as FilingRefs. */
async function fetchLegacyRefs(symbol: string): Promise<FilingRef[]> {
  const url = `${RESULTS_URL}?index=equities&symbol=${encodeURIComponent(symbol)}&period=Quarterly`;
  const response = await fetchWithSession(url);
  if (!response.ok) throw new Error(`NSE returned HTTP ${response.status} for ${symbol}`);
  const json: unknown = await response.json();
  const rows = z.array(ResultRowSchema.passthrough()).parse(json);

  const refs: FilingRef[] = [];
  for (const row of rows) {
    if (row.format !== "New" || row.cumulative !== "Non-cumulative" || !row.xbrl) continue;
    const periodStart = parseNseDate(row.fromDate);
    const periodEnd = parseNseDate(row.toDate);
    if (!periodStart || !periodEnd) continue;
    refs.push({
      symbol: row.symbol,
      consolidated: row.consolidated === "Consolidated",
      periodStart,
      periodEnd,
      filingDate: parseNseDate(row.filingDate),
      xbrl: row.xbrl,
    });
  }
  return refs;
}

/**
 * The post-2025 feed's rows, as FilingRefs.
 *
 * Best-effort: a failure here is logged and returns nothing, leaving the
 * legacy feed's filings to stand on their own. This endpoint carries the
 * governance filing alongside the financial one under the same quarter, so
 * rows are filtered on `type` before anything is fetched.
 */
async function fetchIntegratedRefs(symbol: string): Promise<FilingRef[]> {
  const url = `${INTEGRATED_URL}?index=equities&symbol=${encodeURIComponent(symbol)}&period=Quarterly`;
  let rows: z.infer<typeof IntegratedRowSchema>[];
  try {
    const response = await fetchWithSession(url, INTEGRATED_REFERER);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json: unknown = await response.json();
    const body = z.object({ data: z.array(IntegratedRowSchema.passthrough()) }).parse(json);
    rows = body.data;
  } catch (cause) {
    logger.warn("nse integrated filings unavailable", { symbol, cause: String(cause) });
    return [];
  }

  const refs: FilingRef[] = [];
  for (const row of rows) {
    if (!row.type.includes("Financials") || !row.xbrl) continue;
    const periodEnd = parseNseDate(row.qe_Date);
    if (!periodEnd) continue;
    refs.push({
      symbol: row.symbol,
      consolidated: row.consolidated === "Consolidated",
      periodStart: quarterStartOf(periodEnd),
      periodEnd,
      filingDate: row.broadcast_Date === null ? null : parseNseDate(row.broadcast_Date),
      xbrl: row.xbrl,
    });
  }
  return refs;
}

/** One filing per quarter — consolidated preferred — newest MAX_FILINGS first. */
function selectRefs(refs: FilingRef[]): FilingRef[] {
  const byPeriod = new Map<string, FilingRef>();
  for (const ref of refs) {
    const existing = byPeriod.get(ref.periodEnd);
    // Prefer Consolidated over Standalone for the same quarter. Where both
    // feeds carry a quarter the first one wins, and the caller passes the
    // integrated feed first, so the filing under the current taxonomy is the
    // one kept.
    if (!existing || (!existing.consolidated && ref.consolidated)) byPeriod.set(ref.periodEnd, ref);
  }
  // Sorted on the PARSED date, never the raw "31-Dec-2024" string: that form
  // compares day-of-month first, so "31-Dec-2024" sorts ahead of
  // "30-Jun-2026" and taking the newest N returned an arbitrary subset —
  // every June quarter fell out, and the two most recent years with them.
  return [...byPeriod.values()]
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, MAX_FILINGS);
}

interface XbrlContext {
  start: string | null;
  end: string | null;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

/** The quarter context and the year-to-date context, as this taxonomy names them. */
const QUARTER_CONTEXT = "OneD";
const YEAR_TO_DATE_CONTEXT = "FourD";
/**
 * The balance-sheet context: an instant at the period end, not a span. Only
 * the half-yearly filings declare it, which is exactly when SEBI requires a
 * balance sheet.
 */
const INSTANT_CONTEXT = "OneI";

/**
 * The element prefixes a financial fact can carry.
 *
 * "in-bse-fin" is the pre-2025 Ind-AS taxonomy; "in-capmkt" is the SEBI
 * Integrated Filing taxonomy that replaced it from the quarter ending
 * 31 March 2025. The local element names are unchanged between the two, so
 * only the prefix has to be recognised — a filing read under the wrong
 * assumption yields no facts at all rather than wrong ones, which is how
 * every post-2024 quarter would otherwise arrive empty.
 */
const PREFIXES = ["in-bse-fin:", "in-capmkt:"] as const;

/** One filing's figures, split by the context each was tagged against. */
interface XbrlFacts {
  /** Values tagged as the quarter alone. */
  quarter: Map<string, number>;
  /** Values tagged as cumulative year-to-date. */
  yearToDate: Map<string, number>;
  /**
   * Values tagged at the POINT IN TIME the period ends — the balance sheet.
   *
   * A half-yearly filing (the quarters ending 30 September and 31 March)
   * carries a full balance sheet, which SEBI requires twice a year and which
   * this adapter previously did not read at all. Equity, borrowings and cash
   * were left null on every Indian company, and return on equity, net cash
   * and leverage with them.
   */
  instant: Map<string, number>;
  /** The declared OneD context, when the document declares one at all. */
  quarterContext: XbrlContext | null;
}

/**
 * Reads one Ind-AS filing, keeping the quarter and year-to-date figures apart.
 *
 * The year-to-date series is read as well as the quarter because the quarter
 * cannot always be trusted on its own — see reconcileFilings below. Values
 * are collected by the contextRef ON THE FACT, which every filing carries,
 * rather than by resolving that reference to a declared context, which many
 * filings are missing entirely.
 */
function parseXbrlFacts(xml: string): XbrlFacts {
  const doc: unknown = xmlParser.parse(xml);
  const quarter = new Map<string, number>();
  const yearToDate = new Map<string, number>();
  const instant = new Map<string, number>();
  let quarterContext: XbrlContext | null = null;

  const walk = (node: unknown, tagName: string | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, tagName);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;

    if (tagName === "xbrli:context" && record["@_id"] === QUARTER_CONTEXT) {
      const period = record["xbrli:period"] as Record<string, unknown> | undefined;
      quarterContext = {
        start: typeof period?.["xbrli:startDate"] === "string" ? period["xbrli:startDate"] : null,
        end: typeof period?.["xbrli:endDate"] === "string" ? period["xbrli:endDate"] : null,
      };
    }

    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith("@_") || key === "#text") continue;
      const prefix = PREFIXES.find((p) => key.startsWith(p));
      if (prefix) {
        const local = key.slice(prefix.length);
        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) {
          if (entry === null || typeof entry !== "object") continue;
          const el = entry as Record<string, unknown>;
          const context = el["@_contextRef"];
          if (
            context !== QUARTER_CONTEXT &&
            context !== YEAR_TO_DATE_CONTEXT &&
            context !== INSTANT_CONTEXT
          ) {
            continue;
          }
          const text = el["#text"];
          const num = typeof text === "number" ? text : typeof text === "string" ? Number(text) : NaN;
          if (!Number.isFinite(num)) continue;
          if (context === QUARTER_CONTEXT) quarter.set(local, num);
          else if (context === INSTANT_CONTEXT) instant.set(local, num);
          else yearToDate.set(local, num);
        }
      }
      walk(value, key);
    }
  };

  walk(doc, null);
  return { quarter, yearToDate, instant, quarterContext };
}

/** One filing fetched and parsed, before its figures have been trusted. */
interface Filing {
  ref: FilingRef;
  facts: XbrlFacts;
}

async function fetchFiling(ref: FilingRef): Promise<Filing | null> {
  const span = daysBetween(ref.periodStart, ref.periodEnd);
  if (span < 80 || span > 100) return null;

  const response = await fetch(ref.xbrl, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  return { ref, facts: parseXbrlFacts(await response.text()) };
}

/**
 * The P&L lines that accumulate through a fiscal year, so may be differenced.
 *
 * Two reporting shapes, because a bank does not file the same statement a
 * manufacturer does: there is no "revenue from operations" line in a bank's
 * filing at all, and its profit lines carry different names. Both sets are
 * read from every filing — a company files one shape or the other, so the
 * tags it does not use are simply absent.
 */
const CUMULATIVE_TAGS = [
  // Ind-AS commercial shape.
  "RevenueFromOperations",
  "Income",
  "ProfitBeforeTax",
  "ProfitOrLossAttributableToOwnersOfParent",
  "ProfitLossForPeriod",
  // Banking shape.
  "InterestEarned",
  "ProfitLossFromOrdinaryActivitiesBeforeTax",
  "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates",
  "ProfitLossForThePeriod",
] as const;

/** Two figures agree if they match to within a rounding step of each other. */
function agrees(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale < 0.005;
}

/** The Indian fiscal year (Apr-Mar) a quarter end belongs to, as its March end date. */
function fiscalYearEndOf(periodEnd: string): string {
  const [y, m] = periodEnd.split("-").map(Number);
  return `${m <= 3 ? y : y + 1}-03-31`;
}

/**
 * Establishes each filing's quarter figures, VERIFYING rather than trusting
 * the quarter-tagged values.
 *
 * WHY THIS IS NOT SIMPLY READING THE OneD CONTEXT
 *
 * Two independent defects, both confirmed against live TCS filings:
 *
 * 1. A filing declares a FourD context (a 9-month year-to-date figure, ~3x
 *    the quarter) carrying the SAME start/end dates as OneD. The filer's XBRL
 *    software mislabelled it, so a context's own dates cannot be believed.
 * 2. Older filings reference contextRef="OneD" on every fact while declaring
 *    no OneD context ANYWHERE in the document — a dangling reference, and
 *    invalid XBRL. There is nothing to date-check at all.
 *
 * Defect 2 silently cost eleven of TCS's filings, which is most of its
 * history, and with them every trailing growth figure.
 *
 * So period boundaries are taken from the results endpoint's own
 * fromDate/toDate — NSE's API, not the filer's XBRL — and the quarter figures
 * are proved against the year-to-date series instead: within one fiscal year
 * the cumulative figures must differ, from one quarter to the next, by
 * exactly the standalone quarter. That is exact arithmetic on one filer's own
 * numbers, and it is a STRICTER test than comparing dates, because it catches
 * a year-to-date figure mislabelled as a quarter even when the dates on it
 * look right.
 *
 * A filing whose quarter figure contradicts that arithmetic is dropped, as
 * before. What has changed is that a filing missing its context declaration
 * is now provable instead of unreadable.
 */
function reconcileFilings(filings: Filing[]): Map<Filing, Map<string, number>> {
  const resolved = new Map<Filing, Map<string, number>>();

  const byFiscalYear = new Map<string, Filing[]>();
  for (const filing of filings) {
    const key = fiscalYearEndOf(filing.ref.periodEnd);
    const bucket = byFiscalYear.get(key) ?? [];
    bucket.push(filing);
    byFiscalYear.set(key, bucket);
  }

  for (const group of byFiscalYear.values()) {
    const ordered = [...group].sort((a, b) => a.ref.periodStart.localeCompare(b.ref.periodStart));

    for (const [index, filing] of ordered.entries()) {
      const previous = index > 0 ? ordered[index - 1] : null;
      // A previous quarter only anchors the difference if it is genuinely the
      // one immediately before this quarter — the same one-quarter window
      // derive-metrics.ts uses, NOT an exact day count, since a quarter runs
      // anywhere from 89 to 92 days.
      const gap =
        previous === null ? null : daysBetween(previous.ref.periodEnd, filing.ref.periodEnd);
      const chained = gap !== null && gap >= 80 && gap <= 100 ? previous : null;
      // An Indian fiscal year opens on 1 April, so a filing starting then is
      // that year's first quarter whatever its position in the fetched set.
      const isFirstQuarterOfYear = filing.ref.periodStart.endsWith("-04-01");

      const values = new Map<string, number>();
      for (const tag of CUMULATIVE_TAGS) {
        const quarterValue = filing.facts.quarter.get(tag);
        const ytd = filing.facts.yearToDate.get(tag);

        // The first quarter of a fiscal year IS its own year-to-date figure.
        // Where both are reported they must be equal, which is a complete
        // proof on its own that the quarter-tagged value is a quarter.
        if (isFirstQuarterOfYear) {
          if (quarterValue !== undefined && (ytd === undefined || agrees(quarterValue, ytd))) {
            values.set(tag, quarterValue);
          } else if (ytd !== undefined && quarterValue === undefined) {
            values.set(tag, ytd);
          }
          continue;
        }

        const priorYtd = chained?.facts.yearToDate.get(tag);
        const differenced = ytd !== undefined && priorYtd !== undefined ? ytd - priorYtd : undefined;

        if (differenced !== undefined && quarterValue !== undefined) {
          // Both routes available: they must agree, or this filing is the
          // mislabelled kind and its figure is not usable.
          if (agrees(differenced, quarterValue)) values.set(tag, quarterValue);
          continue;
        }
        if (differenced !== undefined) {
          values.set(tag, differenced);
          continue;
        }
        // No year-to-date chain to prove anything with. Fall back to the
        // quarter-tagged value only when the document's own OneD context
        // declares exactly this period, which is the original check.
        const context = filing.facts.quarterContext;
        if (
          quarterValue !== undefined &&
          context?.start === filing.ref.periodStart &&
          context?.end === filing.ref.periodEnd
        ) {
          values.set(tag, quarterValue);
        }
      }

      if (values.size > 0) resolved.set(filing, values);
      else {
        logger.warn("nse filing figures could not be verified; skipping", {
          symbol: filing.ref.symbol,
          periodEnd: filing.ref.periodEnd,
          declaredContext: filing.facts.quarterContext,
        });
      }
    }
  }

  return resolved;
}

function buildPeriod(filing: Filing, values: Map<string, number>): RawPeriod {
  // Commercial line first, banking line second. A bank files no "revenue from
  // operations" at all; interest earned is the operating top line, and total
  // income adds non-interest income to it, mirroring the commercial split
  // between revenue and total income exactly.
  const revenue = values.get("RevenueFromOperations") ?? values.get("InterestEarned") ?? null;
  const totalIncome = values.get("Income") ?? revenue;
  const netIncome =
    values.get("ProfitOrLossAttributableToOwnersOfParent") ??
    values.get("ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates") ??
    values.get("ProfitLossForPeriod") ??
    values.get("ProfitLossForThePeriod") ??
    null;
  const pretaxIncome =
    values.get("ProfitBeforeTax") ?? values.get("ProfitLossFromOrdinaryActivitiesBeforeTax") ?? null;

  // Share capital is a point-in-time stock, never differenced across a year,
  // so it is read from the quarter context as filed or not at all.
  const paidUpCapital = filing.facts.quarter.get("PaidUpValueOfEquityShareCapital") ?? null;
  const faceValue = filing.facts.quarter.get("FaceValueOfEquityShareCapital") ?? null;
  const sharesOutstanding =
    paidUpCapital !== null && faceValue !== null && faceValue !== 0 ? paidUpCapital / faceValue : null;

  // The diluted share count, from the two figures the filing does state:
  // profit for the quarter and diluted earnings per share for that same
  // quarter. An Indian filing carries no share count other than paid-up
  // capital, which is the UNdiluted number, so trailing EPS, the trailing
  // multiple and the declared payout ratio were all unreportable for any
  // company Yahoo happened not to cover — Trent among them.
  const dilutedEps =
    filing.facts.quarter.get("DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations") ??
    filing.facts.quarter.get("DilutedEarningsPerShareAfterExtraordinaryItems") ??
    filing.facts.quarter.get("DilutedEarningsLossPerShareFromContinuingOperations") ??
    null;
  const dilutedShares =
    netIncome !== null && dilutedEps !== null && dilutedEps !== 0 ? netIncome / dilutedEps : null;

  // The balance sheet, present only in the half-yearly filings. Every figure
  // below is an instant at this period's end, never summed or differenced.
  const instant = filing.facts.instant;
  const equity =
    instant.get("EquityAttributableToOwnersOfParent") ??
    instant.get("Equity") ??
    instant.get("CapitalAndReservesAttributableToOwners") ??
    null;
  const noncurrentBorrowings = instant.get("BorrowingsNoncurrent") ?? null;
  const currentBorrowings = instant.get("BorrowingsCurrent") ?? null;
  const totalDebt =
    noncurrentBorrowings !== null || currentBorrowings !== null
      ? (noncurrentBorrowings ?? 0) + (currentBorrowings ?? 0)
      : null;
  const cash = instant.get("CashAndCashEquivalentsCashFlowStatement") ?? null;

  return {
    periodEnd: filing.ref.periodEnd,
    months: 3,
    basis: filing.ref.consolidated ? "consolidated" : "standalone",
    currency: "INR",
    source: "nse-bse",
    filingDate: filing.ref.filingDate,
    revenue,
    totalIncome,
    otherIncome:
      revenue !== null && totalIncome !== null && totalIncome !== revenue
        ? totalIncome - revenue
        : null,
    costOfRevenue: null,
    grossProfit: null,
    operatingIncome: null,
    pretaxIncome,
    netIncome,
    dilutedShares,
    operatingCashFlow: null,
    capex: null,
    dividendsPaid: null,
    equity,
    totalDebt,
    cash,
    sharesOutstanding,
  };
}

/** Sums four same-fiscal-year, same-basis, contiguous quarters into an annual period. */
function synthesizeAnnual(quarters: RawPeriod[]): RawPeriod[] {
  const byYear = new Map<string, RawPeriod[]>();
  for (const q of quarters) {
    // Group by the fiscal year ending on the next Mar-31 on/after this quarter.
    const [y, m] = q.periodEnd.split("-").map(Number);
    const fyEndYear = m <= 3 ? y : y + 1;
    const key = `${fyEndYear}-03-31`;
    const bucket = byYear.get(key) ?? [];
    bucket.push(q);
    byYear.set(key, bucket);
  }

  const annual: RawPeriod[] = [];
  for (const [fyEnd, group] of byYear) {
    if (group.length !== 4) continue;
    const bases = new Set(group.map((q) => q.basis));
    if (bases.size !== 1) continue;
    const sum = (line: "revenue" | "netIncome"): number | null => {
      if (group.some((q) => q[line] === null)) return null;
      return group.reduce((total, q) => total + (q[line] as number), 0);
    };
    const revenue = sum("revenue");
    const netIncome = sum("netIncome");
    if (revenue === null && netIncome === null) continue;
    annual.push({
      periodEnd: fyEnd,
      months: 12,
      basis: group[0].basis,
      currency: "INR",
      source: "nse-bse",
      filingDate: null,
      revenue,
      totalIncome: revenue,
      otherIncome: null,
      costOfRevenue: null,
      grossProfit: null,
      operatingIncome: null,
      pretaxIncome: null,
      netIncome,
      dilutedShares: null,
      operatingCashFlow: null,
      capex: null,
      dividendsPaid: null,
      equity: null,
      totalDebt: null,
      cash: null,
      sharesOutstanding: null,
      reconstructed: true,
    });
  }
  return annual.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

export async function getNseStatements(symbol: string): Promise<RawStatements | null> {
  try {
    // Newest feed first so that at the one quarter where the two overlap, the
    // filing under the current taxonomy is the one kept.
    const [integrated, legacy, corporateActions] = await Promise.all([
      fetchIntegratedRefs(symbol),
      fetchLegacyRefs(symbol),
      fetchCorporateActions(symbol),
    ]);
    const selected = selectRefs([...integrated, ...legacy]);
    if (selected.length === 0) {
      logger.info("nse has no usable filings for symbol", { symbol });
      return null;
    }

    const fetched = await Promise.all(selected.map((ref) => fetchFiling(ref)));
    const filings = fetched.filter((f): f is Filing => f !== null);
    const verified = reconcileFilings(filings);

    const quarterly = [...verified]
      .map(([filing, values]) => buildPeriod(filing, values))
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));

    if (quarterly.length === 0) {
      logger.info("nse produced no usable quarters for symbol", { symbol });
      return null;
    }

    return {
      quarterly,
      annual: synthesizeAnnual(quarterly),
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
      corporateActions,
    };
  } catch (cause) {
    logger.warn("nse statements unavailable", { symbol, cause: String(cause) });
    return null;
  }
}
