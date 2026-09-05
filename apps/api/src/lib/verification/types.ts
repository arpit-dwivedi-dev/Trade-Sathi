/**
 * Generic, domain-agnostic verification contracts. Nothing here knows about
 * fundamentals, candles, or any other feature — a `VerificationEngine` takes
 * a list of field claims and returns a verdict per field, sourced through a
 * pluggable `SearchProvider`. Fundamentals-specific rules, field lists and
 * the concrete engine live in services/fundamentals-verification.service.ts;
 * this file exists so a second domain (or a second SearchProvider) can reuse
 * the same shapes without depending on that service.
 */

/**
 * How much weight a source carries. Tier1 is a primary/official source
 * (exchange, regulator, company filing or IR page); tier2 reproduces or
 * derives from those; tier3 is general web/news, usable only for
 * corroboration, never alone, and never for an automatic correction.
 */
export type SourceTier = "tier1" | "tier2" | "tier3";

export interface Source {
  tier: SourceTier;
  /** Human label, e.g. "NSE India", "Screener.in". */
  name: string;
  url: string;
}

/** One hit from a SearchProvider, before any field-specific extraction. */
export interface SearchResult {
  source: Source;
  title: string;
  snippet: string;
}

/**
 * A pluggable web/search backend. Deliberately independent of
 * VerificationEngine — a provider only answers "what did a search for this
 * query turn up", it never decides what any of it means for a field.
 */
export interface SearchProvider {
  readonly name: string;
  /** False when the provider has no usable configuration (e.g. no base URL
   *  set) — callers treat that as "no evidence available", not an error. */
  isConfigured(): boolean;
  search(query: string): Promise<SearchResult[]>;
}

export type AccountingBasis = "standalone" | "consolidated" | "unknown";

/** One piece of corroborating (or conflicting) evidence for a field. */
export interface Evidence {
  source: Source;
  snippet: string;
  extractedValue: number | string | null;
  /** Fiscal/reporting period the evidence's value applies to, if stated. */
  period: string | null;
  asOfDate: string | null;
  basis: AccountingBasis;
}

/** What the caller is asking the engine to check for one field. */
export interface VerificationRequest {
  /** Dotted path into the source payload, e.g. "health.sharesOutstanding". */
  field: string;
  value: number | string | null;
  period: string | null;
  asOfDate: string | null;
  basis: AccountingBasis;
  currency: string | null;
  /** Free-form context a concrete engine can use to build search queries
   *  (company name, symbol, exchange, and so on). */
  context: Record<string, unknown>;
}

/**
 * There is deliberately no "corrected" member.
 *
 * A verification layer that cannot write to the data it audits must not be
 * able to claim it corrected anything, and removing the member makes that a
 * compile error rather than a convention. Evidence that disagrees with a
 * value is a "conflict": recorded, surfaced, and never applied.
 */
export type FieldVerificationStatus =
  | "verified_match"
  | "conflict"
  | "unverifiable"
  | "unchecked";

/**
 * Everything preserved for one checked field, per the audit requirements:
 * original value, verified value (if any), status, source(s), evidence,
 * period, as-of date, accounting basis, confidence, discrepancy and the
 * reason behind the status.
 */
export interface FieldVerification {
  field: string;
  originalValue: number | string | null;
  verifiedValue: number | string | null;
  status: FieldVerificationStatus;
  confidence: "high" | "medium" | "low";
  evidence: Evidence[];
  period: string | null;
  asOfDate: string | null;
  basis: AccountingBasis;
  /** Relative delta between original and verified value, when both are
   *  numeric; null when not applicable. */
  discrepancy: number | null;
  reason: string;
  /** Deterministic flags raised before any external lookup, e.g.
   *  ["stale", "unit_mismatch"]. Empty when the field passed cleanly. */
  deterministicFlags: string[];
}

export interface VerificationResult {
  fields: FieldVerification[];
  /** True when at least one field carries an unresolved material conflict. */
  materialConflict: boolean;
  ranAt: string;
  latencyMs: number;
}

export interface VerificationEngine {
  verify(requests: VerificationRequest[]): Promise<VerificationResult>;
}
