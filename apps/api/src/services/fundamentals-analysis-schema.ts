import { z } from "zod";
import type { FundamentalsAnalysisResult } from "@chartanalyzer/shared";

/**
 * The zod mirror of apps/api/src/prompts/fundamentals-analysis.ts's
 * "THE JSON SHAPE", and the (near-identity) normaliser into
 * `FundamentalsAnalysisResult`.
 *
 * Edited in lockstep with that prompt: every key here appears in its JSON
 * shape, at the same nesting, with the same union members. Unlike
 * analysis-schema.ts there is one prompt, not a vision/series pair, so there
 * is nothing to normalise beyond the parse itself — but the function still
 * exists so callers never touch zod's inferred type directly.
 *
 * HOW STRICT, AND WHY — same policy as analysis-schema.ts: enumerations,
 * nesting and types are strict (`strictObject` rejects an unexpected key
 * rather than dropping it), and cardinality the prompt states as a hard rule
 * (deciding_factors 2-4, exactly 3 scenarios one each of bull/base/bear, and
 * so on) is enforced. Soft formatting guidance the prompt gives as a style
 * rule rather than a contract bound (statements under 3 sentences, evidence
 * under 200 characters) is deliberately NOT enforced here: a model running a
 * few characters over a prose-length guideline is not the same failure as one
 * inventing an enum value, and rejecting it would cost the user their
 * entitlement over a cosmetic overage.
 */

const TAG = z.enum(["fact", "calc", "inf", "unk"]);
const BUSINESS_TAG = z.enum(["fact", "inf", "unk"]);
const CLAIM_TAG = z.enum(["fact", "calc", "inf"]);

const evidenceString = z.string().min(1);
const statementString = z.string().min(1);

const claimSchema = z.strictObject({
  claim: z.string().min(1),
  tag: CLAIM_TAG,
  evidence: evidenceString,
});

/** 2 to 4 items, never empty — the prompt's cardinality rule for the verdict's factors. */
const decidingFactors = z.array(claimSchema).min(2).max(4);
/** 0 to 5 items. */
const claimList = z.array(claimSchema).max(5);

/** The bare `{statement, tag, evidence}` shape, with no section-specific verdict. */
const plainTaggedStatement = z.strictObject({
  statement: statementString,
  tag: TAG,
  evidence: evidenceString,
});

/** The same shape plus one section-specific enum verdict, keyed by name. */
function taggedStatement<TKey extends string, TVerdict extends z.ZodTypeAny>(
  verdictKey: TKey,
  verdict: TVerdict,
) {
  return z.strictObject({
    statement: statementString,
    tag: TAG,
    evidence: evidenceString,
    [verdictKey]: verdict,
  } as Record<TKey, TVerdict> & {
    statement: typeof statementString;
    tag: typeof TAG;
    evidence: typeof evidenceString;
  });
}

export const FundamentalsAiSchema = z.strictObject({
  meta: z.strictObject({
    symbol: z.string().min(1),
    completeness: z.number().int().min(0).max(8),
    confidence: z.enum(["high", "medium", "low"]),
    confidence_reason: z.string().min(1),
    material_conflict: z.boolean(),
    data_issues: z.array(z.string()),
    notes: z.array(z.string()),
  }),
  executive_verdict: z.strictObject({
    stance: z.enum(["attractive", "not_attractive", "mixed"]),
    commitment: z.string().min(1),
    deciding_factors: decidingFactors,
    falsifier: z.string().min(1),
  }),
  business: z.strictObject({
    statement: statementString,
    tag: BUSINESS_TAG,
    evidence: evidenceString,
  }),
  performance: z.strictObject({
    revenue_trend: plainTaggedStatement,
    earnings_trend: plainTaggedStatement,
    growth_supports_earnings: z.enum(["yes", "no", "mixed", "unk"]),
  }),
  profitability: taggedStatement(
    "direction",
    z.enum(["improving", "stable", "deteriorating", "volatile", "unk"]),
  ),
  per_share: taggedStatement("dilution", z.enum(["yes", "no", "unk"])),
  balance_sheet: taggedStatement(
    "leverage",
    z.enum(["zero", "low", "moderate", "high", "unk"]),
  ),
  cash_flow: taggedStatement("assessable", z.enum(["yes", "no"])),
  capital_efficiency: taggedStatement("assessable", z.enum(["yes", "no"])),
  dividend: taggedStatement(
    "sustainability",
    z.enum(["conservative", "aggressive", "none", "unk"]),
  ),
  valuation: taggedStatement(
    "read",
    z.enum(["supported", "stretched", "compressed", "unk"]),
  ),
  historical_trend: z.strictObject({
    statement: statementString,
    tag: TAG,
    evidence: evidenceString,
    strongest_period: z.string().nullable(),
    weakest_period: z.string().nullable(),
    // 0 to 4 items, per the prompt's cardinality rule.
    inflections: z.array(z.string()).max(4),
  }),
  positive_signals: claimList,
  red_flags: claimList,
  scenarios: z
    .array(
      z.strictObject({
        id: z.enum(["bull", "base", "bear"]),
        view: z.string().min(1),
        requires: z.string().min(1),
        falsifier: z.string().min(1),
      }),
    )
    // Exactly 3 entries, one each of "bull", "base" and "bear" — checked
    // below rather than with a fixed-length tuple, so an out-of-order (but
    // complete) triple still validates.
    .length(3)
    .superRefine((scenarios, ctx) => {
      const ids = new Set(scenarios.map((s) => s.id));
      for (const required of ["bull", "base", "bear"] as const) {
        if (!ids.has(required)) {
          ctx.addIssue({
            code: "custom",
            path: ["scenarios"],
            message: `scenarios must include exactly one '${required}' entry`,
          });
        }
      }
    }),
  // 0 to 6 items.
  missing_information: z
    .array(
      z.strictObject({
        item: z.string().min(1),
        impact: z.string().min(1),
      }),
    )
    .max(6),
  summary: z.string().min(1),
});

export type FundamentalsAiResponse = z.infer<typeof FundamentalsAiSchema>;

/**
 * The parsed response already matches `FundamentalsAnalysisResult` field for
 * field — there is one prompt, not a union to collapse — so this is a type
 * assertion rather than a reshaping. It still exists as a named function so
 * every caller goes through the same seam analysis-schema.ts's normalisers do,
 * and a future divergence between the two shapes has one place to fix.
 */
export function normalizeFundamentalsAnalysis(
  parsed: FundamentalsAiResponse,
): FundamentalsAnalysisResult {
  return parsed;
}
