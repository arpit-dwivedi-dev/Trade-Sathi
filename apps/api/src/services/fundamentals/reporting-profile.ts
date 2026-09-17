import type { ReportingProfile } from "@tradesathi/shared";

/**
 * Resolves the ReportingProfile for one instrument, once, so deriveMetrics()
 * never has to ask what market it is looking at.
 *
 * DO NOT ADD A COUNTRY BRANCH HERE. The properties on ReportingProfile are
 * the real variables — fiscal-year-end month, which line counts as revenue,
 * whether two accounting bases are filed — and every one of them recurs
 * outside the country that first motivated it. A `if (country === "IN")`
 * branch works exactly until the first Ind AS filer listed elsewhere, or the
 * first US filer with a non-December year end.
 */

/** The exchanges the catalogue actually carries. */
const KNOWN_EXCHANGES = ["NSE", "BSE", "NASDAQ", "NYSE"] as const;
type KnownExchange = (typeof KNOWN_EXCHANGES)[number];

function isKnownExchange(value: string): value is KnownExchange {
  return (KNOWN_EXCHANGES as readonly string[]).includes(value);
}

export interface ResolveProfileInput {
  exchange: string;
  /**
   * The fiscal-year-end month READ FROM THE FILINGS (1-12), i.e. the calendar
   * month of the latest annual statement's period end. Never assumed:
   * NVDA's fiscal year ends in January, and defaulting it to December
   * mislabels every one of its fiscal-year figures by eleven months.
   */
  fiscalYearEndMonthFromFilings: number | null;
  /** meta.financialCurrency — the currency the STATEMENTS are reported in. */
  reportingCurrency: string | null;
  /** Bases actually observed across the fetched statements. */
  basisObserved?: ('consolidated' | 'standalone')[];
  /** Corporate actions known to fall in the derivation window. */
  corporateActions?: ('split' | 'bonus' | 'buyback')[];
}

/**
 * Ind AS markets: April-March fiscal year, revenue from operations reported
 * separately from total income, consolidated AND standalone both filed every
 * quarter, Q4 published as the balancing figure against the audited year,
 * bonus issues routine, figures read in crore.
 */
const IND_AS_DEFAULTS = {
  fiscalYearEndMonth: 3,
  revenueLine: "revenue_from_operations",
  basisAvailable: ["consolidated", "standalone"],
  displayUnit: "crore",
  q4IsBalancingFigure: true,
  corporateActions: ["bonus"],
  reportingCurrency: "INR",
} as const;

/**
 * US GAAP markets: fiscal year end varies by filer and must come from the
 * filing, one consolidated basis, no Q4 balancing convention, figures read
 * in billions.
 */
const US_GAAP_DEFAULTS = {
  revenueLine: "total_revenue",
  basisAvailable: ["consolidated"],
  displayUnit: "billion",
  q4IsBalancingFigure: false,
  corporateActions: [],
  reportingCurrency: "USD",
} as const;

const MARKET_CALENDARS: Record<KnownExchange, string> = {
  NSE: "XNSE",
  BSE: "XBOM",
  NASDAQ: "XNYS",
  NYSE: "XNYS",
};

export function resolveReportingProfile(input: ResolveProfileInput): ReportingProfile {
  const exchange: KnownExchange = isKnownExchange(input.exchange) ? input.exchange : "NSE";
  const indAs = exchange === "NSE" || exchange === "BSE";

  const base = indAs ? IND_AS_DEFAULTS : US_GAAP_DEFAULTS;

  // The filing wins over any default. For an Ind AS filer the two agree
  // (March), so the default only ever fills a genuine gap; for a US filer
  // there IS no sensible default, which is why the fallback below is
  // December only as a last resort and the derivation labels every fiscal
  // period from this number.
  const fiscalYearEndMonth =
    input.fiscalYearEndMonthFromFilings ?? (indAs ? IND_AS_DEFAULTS.fiscalYearEndMonth : 12);

  // Bases actually seen in the fetched statements narrow the declared
  // availability — a filer that only ever returned consolidated rows should
  // not have standalone claimed for it.
  const basisAvailable =
    input.basisObserved && input.basisObserved.length > 0
      ? [...new Set(input.basisObserved)]
      : [...base.basisAvailable];

  const corporateActions = input.corporateActions
    ? [...new Set([...base.corporateActions, ...input.corporateActions])]
    : [...base.corporateActions];

  return {
    exchange,
    fiscalYearEndMonth,
    revenueLine: base.revenueLine,
    basisAvailable,
    preferredBasis: "consolidated",
    reportingCurrency: input.reportingCurrency ?? base.reportingCurrency,
    displayUnit: base.displayUnit,
    q4IsBalancingFigure: base.q4IsBalancingFigure,
    corporateActions,
    marketCalendar: MARKET_CALENDARS[exchange],
  };
}

/**
 * The fiscal year a period-end date belongs to, named the way the market
 * names it: an Indian filer's year ending March 2026 is FY2026, and NVDA's
 * year ending January 2026 is also FY2026. Both are "the fiscal year that
 * ends in this calendar year" — which holds for every fiscal-year-end month
 * from January through to December.
 */
export function fiscalYearOf(periodEnd: string): number {
  return Number(periodEnd.slice(0, 4));
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Renders a fiscal year with its actual months spelled out — always
 * "FY2026 (Apr 2025 – Mar 2026)", never a bare "FY2026".
 *
 * A bare label is ambiguous across exactly the two companies this pipeline
 * was getting wrong at the same time: NVDA's FY2026 ends January 2026 and
 * TCS's FY2026 ends March 2026, and a reader given "FY2026" for both has no
 * way to know they are eleven months apart.
 */
export function formatFiscalYearLabel(
  periodEnd: string,
  profile: ReportingProfile,
): string {
  const year = fiscalYearOf(periodEnd);
  const endMonth = profile.fiscalYearEndMonth;
  // The first month of the fiscal year is the month after it ends.
  const startMonthIndex = endMonth % 12;
  const startYear = endMonth === 12 ? year : year - 1;
  return (
    `FY${year} (${MONTH_NAMES[startMonthIndex]} ${startYear} – ` +
    `${MONTH_NAMES[endMonth - 1]} ${year})`
  );
}
