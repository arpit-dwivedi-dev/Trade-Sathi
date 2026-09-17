/**
 * DISABLED FOR FUNDAMENTALS — September 2026.
 *
 * Snippet corroboration confirmed quarterly-basis values as `verified_match`
 * on TCS: it rubber-stamped the exact errors that broke the report. Search
 * cannot resolve period or basis semantics — a web page saying "revenue grew
 * 13.9%" agrees with a payload field saying 0.139 whether that field is a
 * quarterly figure or a trailing one, and the whole defect was that it was
 * quarterly wearing a trailing label.
 *
 * This module is RETAINED for reuse by the news-analysis feature. It has been
 * made structurally incapable of changing fundamentals data: see
 * verifyFundamentalsPayload, which now returns the caller's own payload
 * object by reference. That, not the environment flag, is the actual safety
 * property — a flag gets switched back on by accident one day, and this makes
 * that harmless.
 *
 * The reusable pieces have moved to lib/search/ (the SearXNG client,
 * classifyHost, the result cache). The fundamentals-specific pieces below —
 * the 60-character window extraction, interpretNumber, value clustering and
 * the verdict ladder — stay here on purpose: news will not need them, and
 * keeping them separated prevents them being reused by accident.
 */

import type { InstrumentFundamentals } from "@tradesathi/shared";
import { env } from "../lib/env.js";
import { logAppError } from "../lib/error-log.js";
import { logger } from "../lib/logger.js";
import { SearchResultCache } from "../lib/search/search-cache.js";
import { SearxngSearchProvider } from "../lib/search/searxng-search-provider.js";
import type {
  AccountingBasis,
  Evidence,
  FieldVerification,
  FieldVerificationStatus,
  SearchProvider,
  SearchResult,
  VerificationResult,
} from "../lib/verification/types.js";
import type { InstrumentRef } from "./market-chart.service.js";

/**
 * The fundamental data verification middle layer: sits between the raw
 * yFinance-backed InstrumentFundamentals fetch and the existing, unmodified
 * fundamentals AI prompt/schema. It deterministically audits the
 * highest-impact fields, best-effort cross-checks the ones that look wrong
 * or missing against authoritative sources through a pluggable
 * SearchProvider, and returns a payload the AI call is none the wiser was
 * ever touched — plus a full audit trail for persistence.
 *
 * Every entry point here is best-effort: a verifier failure must never fail
 * or slow down the fundamentals analysis pipeline. See
 * verifyFundamentalsPayload for the outer safety net.
 */

// ---------------------------------------------------------------------------
// Field targets
// ---------------------------------------------------------------------------

type FieldKind = "price" | "absolute" | "fraction" | "multiple" | "count";

/**
 * A group is the unit of external lookup: fields sharing a group are
 * corroborated with ONE search query and its results shared across them,
 * rather than one query per field. This is what keeps the external call
 * count bounded to a handful per instrument per cache window instead of one
 * per priority field.
 */
type FieldGroup =
  | "valuation_shares"
  | "balance_sheet"
  | "dividend"
  | "annual_financials"
  | "cash_flow";

type PeriodClass = "point_in_time" | "quarterly" | "trailing" | "annual_latest";

interface FieldSpec {
  path: string;
  kind: FieldKind;
  group: FieldGroup;
  periodClass: PeriodClass;
  /** Words used both to build the group's search query and to locate the
   *  value inside a search snippet. */
  synonyms: string[];
  get: (p: InstrumentFundamentals) => number | null;
}

function latestAnnual(p: InstrumentFundamentals) {
  return p.annual.length > 0 ? p.annual[p.annual.length - 1] : null;
}

const FIELD_SPECS: FieldSpec[] = [
  {
    path: "snapshot.price",
    kind: "price",
    group: "valuation_shares",
    periodClass: "point_in_time",
    synonyms: ["share price", "stock price", "current price"],
    get: (p) => p.snapshot.price,
  },
  {
    path: "snapshot.marketCap",
    kind: "absolute",
    group: "valuation_shares",
    periodClass: "point_in_time",
    synonyms: ["market cap", "market capitalisation", "market capitalization"],
    get: (p) => p.snapshot.marketCap,
  },
  {
    path: "snapshot.fiftyTwoWeekLow",
    kind: "price",
    group: "valuation_shares",
    periodClass: "point_in_time",
    synonyms: ["52 week low", "52-week low"],
    get: (p) => p.snapshot.fiftyTwoWeekLow,
  },
  {
    path: "snapshot.fiftyTwoWeekHigh",
    kind: "price",
    group: "valuation_shares",
    periodClass: "point_in_time",
    synonyms: ["52 week high", "52-week high"],
    get: (p) => p.snapshot.fiftyTwoWeekHigh,
  },
  {
    path: "health.sharesOutstanding",
    kind: "count",
    group: "valuation_shares",
    periodClass: "quarterly",
    synonyms: ["shares outstanding", "outstanding shares"],
    get: (p) => p.health.sharesOutstanding,
  },
  {
    path: "valuation.trailingEps",
    kind: "price",
    group: "valuation_shares",
    periodClass: "trailing",
    synonyms: ["trailing eps", "eps (ttm)", "eps ttm"],
    get: (p) => p.valuation.trailingEps,
  },
  {
    path: "valuation.trailingPe",
    kind: "multiple",
    group: "valuation_shares",
    periodClass: "trailing",
    synonyms: ["trailing pe", "p/e ratio", "pe ratio"],
    get: (p) => p.valuation.trailingPe,
  },
  {
    path: "valuation.forwardPe",
    kind: "multiple",
    group: "valuation_shares",
    periodClass: "trailing",
    synonyms: ["forward pe", "forward p/e"],
    get: (p) => p.valuation.forwardPe,
  },
  {
    path: "health.totalDebt",
    kind: "absolute",
    group: "balance_sheet",
    periodClass: "quarterly",
    synonyms: ["total debt"],
    get: (p) => p.health.totalDebt,
  },
  {
    path: "health.totalCash",
    kind: "absolute",
    group: "balance_sheet",
    periodClass: "quarterly",
    synonyms: ["total cash"],
    get: (p) => p.health.totalCash,
  },
  {
    path: "health.debtToEquity",
    kind: "multiple",
    group: "balance_sheet",
    periodClass: "quarterly",
    synonyms: ["debt to equity", "debt/equity", "d/e ratio"],
    get: (p) => p.health.debtToEquity,
  },
  {
    path: "valuation.dividendRate",
    kind: "price",
    group: "dividend",
    periodClass: "trailing",
    synonyms: ["dividend rate", "dividend per share", "dps"],
    get: (p) => p.valuation.dividendRate,
  },
  {
    path: "valuation.dividendYield",
    kind: "fraction",
    group: "dividend",
    periodClass: "trailing",
    synonyms: ["dividend yield"],
    get: (p) => p.valuation.dividendYield,
  },
  {
    path: "health.operatingCashflow",
    kind: "absolute",
    group: "cash_flow",
    periodClass: "trailing",
    synonyms: ["operating cash flow", "cash from operations"],
    get: (p) => p.health.operatingCashflow,
  },
  {
    path: "annual.latest.revenue",
    kind: "absolute",
    group: "annual_financials",
    periodClass: "annual_latest",
    synonyms: ["annual revenue", "total revenue", "net sales"],
    get: (p) => latestAnnual(p)?.revenue ?? null,
  },
  {
    path: "annual.latest.netIncome",
    kind: "absolute",
    group: "annual_financials",
    periodClass: "annual_latest",
    synonyms: ["net income", "net profit", "annual profit"],
    get: (p) => latestAnnual(p)?.netIncome ?? null,
  },
];

// ---------------------------------------------------------------------------
// Deterministic validation — pure, no network. Mirrors the tolerance and
// staleness rules the existing prompt already applies internally (see
// prompts/fundamentals-analysis.ts STALENESS/CURRENCY GATE/TOLERANCE), so
// the two layers never disagree about what counts as stale or material.
// ---------------------------------------------------------------------------

const RELATIVE_TOLERANCE = 0.05;
const FRACTION_ABSOLUTE_TOLERANCE = 0.005;
const POINT_IN_TIME_STALE_MS = 5 * 24 * 60 * 60 * 1000;
const QUARTERLY_STALE_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function relativeDiff(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  return Math.abs(a - b) / Math.abs(a || b);
}

function reconciled(supplied: number, recomputed: number, kind: FieldKind): boolean {
  const diff = relativeDiff(supplied, recomputed);
  if (kind === "fraction" && Math.abs(supplied - recomputed) < FRACTION_ABSOLUTE_TOLERANCE) {
    return true;
  }
  return diff <= RELATIVE_TOLERANCE;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime());
}

/** Currency gate: valid only when both currencies are present and identical. */
function currencyGateOpen(p: InstrumentFundamentals): boolean {
  return (
    p.meta.currency !== null &&
    p.meta.financialCurrency !== null &&
    p.meta.currency === p.meta.financialCurrency
  );
}

/**
 * Runs every deterministic check applicable to one field and returns the
 * flags it raised. An empty array means the field passed cleanly.
 */
function deterministicFlags(spec: FieldSpec, p: InstrumentFundamentals): string[] {
  const flags: string[] = [];
  const value = spec.get(p);

  if (value === null) {
    flags.push("missing");
    return flags; // nothing else to check against a value that isn't there
  }

  // Staleness
  if (spec.periodClass === "point_in_time") {
    if (!p.meta.asOf || daysBetween(p.meta.asOf, new Date().toISOString()) > POINT_IN_TIME_STALE_MS) {
      flags.push("stale");
    }
  } else if (spec.periodClass === "annual_latest") {
    const last = latestAnnual(p);
    if (last && p.meta.asOf && daysBetween(last.asOfDate, p.meta.asOf) > QUARTERLY_STALE_MS * 2) {
      flags.push("stale");
    }
  } else if (p.meta.mostRecentQuarter && p.meta.asOf) {
    if (daysBetween(p.meta.mostRecentQuarter, p.meta.asOf) > QUARTERLY_STALE_MS) {
      flags.push("stale");
    }
  } else if (!p.meta.mostRecentQuarter || !p.meta.asOf) {
    flags.push("stale"); // dating unverifiable — treated as a staleness concern
  }

  // Currency/unit mismatch — only the fields that combine a market-currency
  // figure (price) with a financial-statement-currency figure.
  const CURRENCY_GATED_PATHS = new Set([
    "valuation.trailingPe",
    "valuation.forwardPe",
    "valuation.dividendYield",
    "valuation.dividendRate",
  ]);
  if (CURRENCY_GATED_PATHS.has(spec.path) && !currencyGateOpen(p)) {
    flags.push("unit_mismatch");
  }

  // Cross-field arithmetic inconsistencies, mirroring the prompt's STEP 1.
  if (spec.path === "snapshot.marketCap" && p.snapshot.price !== null && p.health.sharesOutstanding !== null) {
    const recomputed = p.snapshot.price * p.health.sharesOutstanding;
    if (!reconciled(value, recomputed, spec.kind)) flags.push("arithmetic_inconsistent");
  }
  if (
    spec.path === "valuation.trailingPe" &&
    currencyGateOpen(p) &&
    p.snapshot.price !== null &&
    p.valuation.trailingEps !== null &&
    p.valuation.trailingEps !== 0
  ) {
    const recomputed = p.snapshot.price / p.valuation.trailingEps;
    if (!reconciled(value, recomputed, spec.kind)) flags.push("arithmetic_inconsistent");
  }
  // The provider's own payout-ratio field used to be audited here, and
  // dividendRate cross-checked against it. Both are gone: a provider-computed
  // ratio is exactly the class of value this pipeline no longer consumes, and
  // the report derives its two payout bases from raw statements instead.
  // dividendRate is still audited on its own, as a reported per-share figure.
  if (
    spec.path === "valuation.dividendYield" &&
    p.valuation.dividendRate !== null &&
    p.snapshot.price
  ) {
    const recomputed = p.valuation.dividendRate / p.snapshot.price;
    // Check both the fraction reading and the "provider sent a percent"
    // reading (~100x), per the existing prompt's own check 6.
    if (!reconciled(value, recomputed, spec.kind) && !reconciled(value, recomputed * 100, spec.kind)) {
      flags.push("arithmetic_inconsistent");
    }
  }

  return flags;
}

function periodLabelFor(spec: FieldSpec, p: InstrumentFundamentals): string | null {
  switch (spec.periodClass) {
    case "point_in_time":
      return p.meta.asOf;
    case "annual_latest":
      return latestAnnual(p)?.asOfDate ?? null;
    default:
      return p.meta.mostRecentQuarter;
  }
}

function asOfDateFor(spec: FieldSpec, p: InstrumentFundamentals): string | null {
  return spec.periodClass === "annual_latest" ? latestAnnual(p)?.asOfDate ?? null : p.meta.asOf;
}

// ---------------------------------------------------------------------------
// Evidence extraction — deliberately conservative. A candidate is only ever
// used to auto-correct or enrich a field when it is unambiguous; anything
// murky (no match, several disagreeing numbers, a different fiscal period)
// falls back to "unverifiable" or "conflict" rather than a guess.
// ---------------------------------------------------------------------------

const NUMBER_PATTERN =
  /(₹|rs\.?|inr|\$)?\s*([\d,]+(?:\.\d+)?)\s*(crore|cr|lakh|lac|million|mn|billion|bn|%)?/gi;

/**
 * Finds the first plausible value in a window of text, skipping a bare
 * 4-digit number that looks like a year (e.g. the "2024" inside "FY2024")
 * when it carries no currency prefix or scale suffix — otherwise a snippet
 * like "Net income FY2024: ₹65,000 crore" would extract 2024 instead of the
 * actual figure.
 */
function findNumberMatch(window: string): { raw: string; scale?: string } | null {
  for (const match of window.matchAll(NUMBER_PATTERN)) {
    const [, currencyPrefix, raw, scale] = match;
    const digitsOnly = raw.replace(/,/g, "");
    const looksLikeBareYear = !scale && !currencyPrefix && /^(19|20)\d{2}$/.test(digitsOnly);
    if (looksLikeBareYear) continue;
    return { raw, scale };
  }
  return null;
}

interface ExtractedCandidate {
  result: SearchResult;
  value: number | null;
  year: number | null;
  basis: AccountingBasis;
}

function expandYear(raw: string): number {
  if (raw.length === 4) return Number(raw);
  const n = Number(raw);
  return n < 50 ? 2000 + n : 1900 + n;
}

function detectYear(snippet: string): number | null {
  const range = snippet.match(/FY\s?(\d{2,4})[-/](\d{2,4})/i);
  if (range) return expandYear(range[2]);
  const single = snippet.match(/FY\s?(\d{2,4})\b/i);
  if (single) return expandYear(single[1]);
  const plain = snippet.match(/\b(20\d{2})\b/);
  if (plain) return Number(plain[1]);
  return null;
}

function detectBasis(snippet: string): AccountingBasis {
  if (/consolidated/i.test(snippet)) return "consolidated";
  if (/standalone/i.test(snippet)) return "standalone";
  return "unknown";
}

/** Converts a matched number + scale suffix to the payload's stored unit
 *  for one field kind. Returns null when the match cannot be interpreted
 *  confidently for that kind. */
function interpretNumber(raw: string, scale: string | undefined, kind: FieldKind): number | null {
  const cleaned = raw.replace(/,/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;

  const scaleLower = scale?.toLowerCase();
  if (kind === "absolute" || kind === "count") {
    switch (scaleLower) {
      case "crore":
      case "cr":
        return num * 1e7;
      case "lakh":
      case "lac":
        return num * 1e5;
      case "million":
      case "mn":
        return num * 1e6;
      case "billion":
      case "bn":
        return num * 1e9;
      case "%":
        return null; // a percent can never be an absolute rupee figure
      default:
        return num;
    }
  }

  if (kind === "fraction") {
    // Stored as a fraction; a snippet almost always states these as a
    // percentage.
    return scaleLower === "%" ? num / 100 : num > 1 ? num / 100 : num;
  }

  // price / multiple: plain figures, scale words are not expected and a hit
  // carrying one is too ambiguous to trust.
  return scaleLower && scaleLower !== "%" ? null : num;
}

function extractCandidate(spec: FieldSpec, result: SearchResult): ExtractedCandidate | null {
  const text = `${result.title} ${result.snippet}`;
  const lower = text.toLowerCase();

  let matchIndex = -1;
  for (const synonym of spec.synonyms) {
    const idx = lower.indexOf(synonym.toLowerCase());
    if (idx !== -1) {
      matchIndex = idx + synonym.length;
      break;
    }
  }
  if (matchIndex === -1) return null;

  const window = text.slice(matchIndex, matchIndex + 60);
  const found = findNumberMatch(window);
  if (!found) return null;

  const value = interpretNumber(found.raw, found.scale, spec.kind);
  return {
    result,
    value,
    year: detectYear(text),
    basis: detectBasis(text),
  };
}

function buildEvidence(candidate: ExtractedCandidate, period: string | null): Evidence {
  return {
    source: candidate.result.source,
    snippet: candidate.result.snippet,
    extractedValue: candidate.value,
    period: candidate.year !== null ? `FY${candidate.year}` : period,
    asOfDate: null,
    basis: candidate.basis,
  };
}

/** Groups usable candidates by approximate agreement (2% relative tolerance
 *  for numeric values). Returns clusters largest/most-agreed-upon first. */
function clusterByValue(candidates: ExtractedCandidate[]): ExtractedCandidate[][] {
  const clusters: ExtractedCandidate[][] = [];
  for (const candidate of candidates) {
    const cluster = clusters.find((c) => {
      const rep = c[0]?.value;
      return rep !== null && candidate.value !== null && relativeDiff(rep, candidate.value) <= 0.02;
    });
    if (cluster) cluster.push(candidate);
    else clusters.push([candidate]);
  }
  return clusters.sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Search-result caching — now the shared implementation in lib/search, kept
// as a module-local instance so this service's cache stays its own.
// ---------------------------------------------------------------------------

const searchCache = new SearchResultCache();

/** Test seam, mirroring clearCandleCache in market-chart.service.ts. */
export function clearFundamentalsVerificationCache(): void {
  searchCache.clear();
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function unresolved(
  spec: FieldSpec,
  p: InstrumentFundamentals,
  status: FieldVerificationStatus,
  reason: string,
  flags: string[],
  evidence: Evidence[] = [],
): FieldVerification {
  return {
    field: spec.path,
    originalValue: spec.get(p),
    verifiedValue: null,
    status,
    confidence: flags.length > 0 ? "low" : "high",
    evidence,
    period: periodLabelFor(spec, p),
    asOfDate: asOfDateFor(spec, p),
    basis: "unknown",
    discrepancy: null,
    reason,
    deterministicFlags: flags,
  };
}

/**
 * Runs the whole verification pass for one payload: deterministic checks on
 * every priority field, followed by one grouped search per FieldGroup that
 * has at least one field needing external corroboration (missing or
 * deterministically flagged as stale/inconsistent — a field that is present
 * and internally consistent is left "unchecked" rather than spending a
 * search call on it every run).
 */
async function runVerification(
  payload: InstrumentFundamentals,
  ref: InstrumentRef,
  searchProvider: SearchProvider,
): Promise<{ fields: FieldVerification[] }> {
  const flagsByPath = new Map<string, string[]>();
  for (const spec of FIELD_SPECS) {
    flagsByPath.set(spec.path, deterministicFlags(spec, payload));
  }

  const needsExternalCheck = (spec: FieldSpec) => {
    const flags = flagsByPath.get(spec.path) ?? [];
    if (flags.includes("unit_mismatch")) return false; // currency gate: unverifiable outright, see below
    return flags.length > 0;
  };

  const groupsNeedingLookup = new Set(
    FIELD_SPECS.filter(needsExternalCheck).map((s) => s.group),
  );

  const resultsByGroup = new Map<FieldGroup, SearchResult[]>();
  if (searchProvider.isConfigured()) {
    await Promise.all(
      [...groupsNeedingLookup].map(async (group) => {
        const specsInGroup = FIELD_SPECS.filter((s) => s.group === group);
        const synonyms = specsInGroup.flatMap((s) => s.synonyms).slice(0, 4);
        const query = `${ref.name} ${ref.symbol} ${synonyms.join(" ")}`.trim();
        const results = await searchCache
          .resolve(`${ref.instrumentKey}|${group}`, () => searchProvider.search(query))
          .catch(() => [] as SearchResult[]);
        resultsByGroup.set(group, results);
      }),
    );
  }

  const fields: FieldVerification[] = [];

  for (const spec of FIELD_SPECS) {
    const flags = flagsByPath.get(spec.path) ?? [];
    const value = spec.get(payload);

    if (flags.includes("unit_mismatch")) {
      fields.push(
        unresolved(
          spec,
          payload,
          "unverifiable",
          "price and financial-statement figures are in different currencies (or one is unreported); the ratio cannot be safely corroborated or corrected",
          flags,
        ),
      );
      continue;
    }

    if (flags.length === 0) {
      fields.push(unresolved(spec, payload, "unchecked", "deterministic checks passed; no external corroboration performed", flags));
      continue;
    }

    if (!searchProvider.isConfigured()) {
      fields.push(unresolved(spec, payload, "unverifiable", "no search provider configured", flags));
      continue;
    }

    const groupResults = resultsByGroup.get(spec.group) ?? [];
    const candidates = groupResults
      .map((r) => extractCandidate(spec, r))
      .filter((c): c is ExtractedCandidate => c !== null);

    const expectedYear = (() => {
      const asOf = asOfDateFor(spec, payload);
      return asOf ? new Date(asOf).getUTCFullYear() : null;
    })();

    const usable = candidates.filter(
      (c) =>
        c.value !== null &&
        c.result.source.tier !== "tier3" &&
        (expectedYear === null || c.year === null || c.year === expectedYear),
    );

    if (usable.length === 0) {
      const allEvidence = candidates.map((c) => buildEvidence(c, periodLabelFor(spec, payload)));
      fields.push(
        unresolved(spec, payload, "unverifiable", "no reliable authoritative evidence found for this field", flags, allEvidence),
      );
      continue;
    }

    const clusters = clusterByValue(usable);
    if (clusters.length > 1) {
      const allEvidence = usable.map((c) => buildEvidence(c, periodLabelFor(spec, payload)));
      fields.push(
        unresolved(spec, payload, "conflict", "authoritative sources disagree on this field's value; original value preserved", flags, allEvidence),
      );
      continue;
    }

    const agreedValue = clusters[0][0].value as number;
    const evidence = clusters[0].map((c) => buildEvidence(c, periodLabelFor(spec, payload)));
    const basis = clusters[0][0].basis;

    if (value === null) {
      fields.push({
        field: spec.path,
        originalValue: null,
        verifiedValue: agreedValue,
        status: "conflict",
        confidence: "medium",
        evidence,
        period: periodLabelFor(spec, payload),
        asOfDate: asOfDateFor(spec, payload),
        basis,
        discrepancy: null,
        reason:
          "an authoritative source carries a value for this unreported field; recorded in the audit only and never applied to the payload",
        deterministicFlags: flags,
      });
      continue;
    }

    const discrepancy = relativeDiff(value, agreedValue);
    if (discrepancy <= RELATIVE_TOLERANCE) {
      fields.push({
        field: spec.path,
        originalValue: value,
        verifiedValue: agreedValue,
        status: "verified_match",
        confidence: "high",
        evidence,
        period: periodLabelFor(spec, payload),
        asOfDate: asOfDateFor(spec, payload),
        basis,
        discrepancy,
        reason: "authoritative evidence agrees with the supplied value within tolerance",
        deterministicFlags: flags,
      });
      continue;
    }

    fields.push({
      field: spec.path,
      originalValue: value,
      verifiedValue: agreedValue,
      status: "conflict",
      confidence: "medium",
      evidence,
      period: periodLabelFor(spec, payload),
      asOfDate: asOfDateFor(spec, payload),
      basis,
      discrepancy,
      reason:
        "authoritative evidence differs materially from the supplied value; recorded in the audit only and never applied to the payload",
      deterministicFlags: flags,
    });
  }

  return { fields };
}

function extractHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Verifies and best-effort enriches one InstrumentFundamentals payload
 * before it reaches the existing fundamentals AI prompt. Never throws: any
 * failure (search provider trouble, an unexpected shape, a timeout) is
 * logged and swallowed, returning the original, unmodified payload with a
 * null audit — the whole point of this layer is to improve data quality
 * without ever being able to make the pipeline worse.
 */
export async function verifyFundamentalsPayload(
  payload: InstrumentFundamentals,
  ref: InstrumentRef,
  profileId?: string,
): Promise<{ payload: InstrumentFundamentals; audit: VerificationResult | null }> {
  if (!env.fundamentalsVerificationEnabled) {
    return { payload, audit: null };
  }

  const startedAt = Date.now();
  try {
    const companyDomain = extractHost(payload.profile.website);
    const searchProvider = new SearxngSearchProvider(
      env.searxngBaseUrl,
      companyDomain ? [companyDomain] : [],
    );

    // This function returns the caller's OWN payload object, by reference:
    // no clone, no setter call, no correction map. There is no code path by
    // which a verdict reached here can alter a number the report reads.
    // Verdicts live in the audit; they no longer touch data.
    const { fields } = await runVerification(payload, ref, searchProvider);

    const audit: VerificationResult = {
      fields,
      materialConflict: fields.some((f) => f.status === "conflict"),
      ranAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };

    return { payload, audit };
  } catch (cause) {
    logger.error("fundamentals verification failed; continuing with unverified payload", {
      instrumentKey: ref.instrumentKey,
      cause: String(cause),
    });
    await logAppError(profileId, "fundamentals_verification", "Fundamentals verification failed", {
      instrumentKey: ref.instrumentKey,
      cause: String(cause),
    });
    return { payload, audit: null };
  }
}
