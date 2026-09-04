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

/**
 * Absolute/unfalsifiable claims a fundamentals report can essentially never
 * earn — a balance sheet is never "pristine", and no amount of net cash
 * "eliminates" risk. These are not stylistic nitpicks: observed verbatim in
 * real model output before this guard existed ("pristine balance sheet",
 * "eliminate balance sheet risk", "severe balance sheet protection",
 * alongside a "supported" valuation read justified purely by quality
 * metrics). Checked as case-insensitive substrings across the whole
 * response — the violation can land in any section, not just one field.
 */
const BANNED_PHRASES = [
  "pristine",
  "eliminate balance-sheet risk",
  "eliminate balance sheet risk",
  "eliminates risk",
  "eliminate risk",
  "risk-free",
  "risk free",
  "zero risk",
  "guaranteed",
  "flawless",
  "bulletproof",
  "unbeatable",
  "severe balance-sheet protection",
  "severe balance sheet protection",
] as const;

function findBannedPhrase(value: unknown): string | null {
  const haystack = JSON.stringify(value).toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Wording that asserts CURRENT margin deterioration, as opposed to a
 * hypothetical one. Deliberately excludes "scenarios" and the verdict's own
 * "falsifier" — those are explicitly hypothetical branches
 * (prompts/fundamentals-analysis.ts's bear scenario is allowed, even expected,
 * to say margins could compress) and banning the phrase there would reject a
 * perfectly correct response. Observed verbatim in real output: a
 * deciding_factor named "margin compression" while profitability.direction
 * was "stable" — an inference the payload's own margin series did not
 * support.
 */
const MARGIN_DETERIORATION_PATTERN =
  /margin(?:s)? (?:is|are|have been|has been)? ?(?:compress|eroding|shrinking|deteriorat)|(?:compress|erod|shrink)ing margins?|margin (?:compression|pressure|erosion)/i;

/**
 * Rejects a claim of current margin compression/pressure/erosion anywhere it
 * would read as a fact about the business today — profitability's own
 * statement, and the claims that back the headline verdict or the
 * signal/flag lists — unless profitability.direction actually supports it
 * ("deteriorating" or "volatile"). A "stable" or "improving" direction makes
 * that wording an unsupported inference the ENUM DECISION RULES section
 * already forbids in principle; this makes it unable to reach a user in
 * practice.
 */
function findUnsupportedMarginDeteriorationClaim(value: {
  profitability: { statement: string; direction: string };
  executive_verdict: { deciding_factors: { claim: string }[] };
  positive_signals: { claim: string }[];
  red_flags: { claim: string }[];
}): string | null {
  if (value.profitability.direction === "deteriorating" || value.profitability.direction === "volatile") {
    return null;
  }
  const candidates = [
    value.profitability.statement,
    ...value.executive_verdict.deciding_factors.map((factor) => factor.claim),
    ...value.positive_signals.map((signal) => signal.claim),
    ...value.red_flags.map((flag) => flag.claim),
  ];
  for (const text of candidates) {
    if (MARGIN_DETERIORATION_PATTERN.test(text)) return text;
  }
  return null;
}

/**
 * Words that flag a derived/estimated figure as such in prose, distinct from
 * the "tag" field the reader never sees rendered. The CALCULATED VALUES
 * section of the prompt names the implied diluted share count formula and
 * requires per_share.statement to carry one of these whenever it states that
 * count — "tag": "calc" alone is not enough, since nothing about the
 * rendered sentence itself tells a reader the figure was derived rather than
 * reported. Observed in real output: a "calc"-tagged per_share.statement
 * stating a specific diluted share count with no qualifying word, reading
 * exactly like a reported figure.
 */
const DERIVATION_HEDGE_PATTERN =
  /implied|derived|estimated|approximat|roughly|computed|calculat|works out to|inferred|extrapolat|based on|suggests|~/i;
const SHARE_COUNT_MENTION_PATTERN = /diluted share count|implied share|share count of/i;

/**
 * Flags per_share.statement when it is tagged "calc" (the implied diluted
 * share count is inherently a calculated figure — see CALCULATED VALUES) and
 * mentions a share count without any wording that marks it as derived. Never
 * fires on "fact" — per_share.tag being "fact" for a genuinely reported
 * figure (e.g. quoting health.sharesOutstanding rather than the implied
 * count) is a separate, legitimate case this check must not touch.
 */
function findUnhedgedImpliedShareCount(value: {
  per_share: { statement: string; tag: string };
}): string | null {
  const { statement, tag } = value.per_share;
  if (tag !== "calc") return null;
  if (!SHARE_COUNT_MENTION_PATTERN.test(statement)) return null;
  if (DERIVATION_HEDGE_PATTERN.test(statement)) return null;
  return statement;
}

/**
 * Catches the one contradictory-scenario-threshold pattern actually observed
 * in production: an APOLLO bear scenario reading "operating margin expanding
 * below -7%" — a margin described as *expanding* while bounded below a
 * *negative* floor is incoherent (nothing expands while forced to stay below
 * a negative value; that is describing collapse into negative territory, not
 * growth).
 *
 * Deliberately narrow, on purpose — an earlier, broader version of this
 * check (any "expand/improve" word followed by "below" and any number, or
 * any "contract/decline" word followed by "above" and any number) rejected
 * completely ordinary, correct wording: "debt-to-equity improving to below
 * 40%" and "leverage deteriorating above 100%" are both coherent because
 * lower is better for leverage — the direction-word-vs-comparator rule this
 * was meant to enforce only holds for margin-style metrics where higher is
 * better, not for every metric in the payload. Scoped to margin wording, and
 * to a negative threshold specifically, so it only fires on the shape of
 * error actually seen rather than on plausible variation. Scoped to
 * "requires"/"falsifier" only, not "view" — "view" is looser narrative prose
 * the prompt does not hold to the same threshold grammar.
 */
const MARGIN_MENTION_PATTERN = /margin/i;
const EXPANDING_BELOW_NEGATIVE_PATTERN =
  /(?:expand\w*|widen\w*|improv\w*|increas\w*|grow\w*)[^.]{0,60}\bbelow\b[^.]{0,25}-\d/i;

function findContradictoryScenarioThreshold(value: {
  scenarios: { id: string; requires: string; falsifier: string }[];
}): { id: string; text: string } | null {
  for (const scenario of value.scenarios) {
    for (const field of [scenario.requires, scenario.falsifier]) {
      if (MARGIN_MENTION_PATTERN.test(field) && EXPANDING_BELOW_NEGATIVE_PATTERN.test(field)) {
        return { id: scenario.id, text: field };
      }
    }
  }
  return null;
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
})
  .superRefine((value, ctx) => {
    // Mirrors the prompt's own CONFIDENCE rule: a flagged material conflict
    // caps confidence, so a response claiming both is internally
    // inconsistent rather than a defensible edge case.
    if (value.meta.material_conflict && value.meta.confidence === "high") {
      ctx.addIssue({
        code: "custom",
        path: ["meta", "confidence"],
        message: "confidence cannot be 'high' when meta.material_conflict is true",
      });
    }

    const bannedPhrase = findBannedPhrase(value);
    if (bannedPhrase) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `response contains a prohibited absolute/superlative phrase: "${bannedPhrase}"`,
      });
    }

    const unsupportedMarginClaim = findUnsupportedMarginDeteriorationClaim(value);
    if (unsupportedMarginClaim) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `claims current margin deterioration ("${unsupportedMarginClaim}") while profitability.direction is "${value.profitability.direction}", which the data does not support`,
      });
    }

    const unhedgedShareCount = findUnhedgedImpliedShareCount(value);
    if (unhedgedShareCount) {
      ctx.addIssue({
        code: "custom",
        path: ["per_share", "statement"],
        message: `per_share.statement states a calculated share count with no derivation wording ("implied"/"derived"/"estimated"): "${unhedgedShareCount}"`,
      });
    }

    const contradictoryThreshold = findContradictoryScenarioThreshold(value);
    if (contradictoryThreshold) {
      ctx.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: `scenario "${contradictoryThreshold.id}" has a direction word that contradicts its own comparator: "${contradictoryThreshold.text}"`,
      });
    }
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
