import { describe, expect, it } from "vitest";
import { FundamentalsAiSchema } from "./fundamentals-analysis-schema.js";

/** A schema-valid response, per prompts/fundamentals-analysis.ts's json shape. */
function validResponse(overrides: Record<string, unknown> = {}) {
  const taggedStatement = (extra: Record<string, unknown> = {}) => ({
    statement: "A statement grounded in the payload.",
    tag: "fact",
    evidence: "health.totalRevenue 9000000000000",
    ...extra,
  });

  return {
    meta: {
      symbol: "RELIANCE",
      completeness: 7,
      confidence: "high",
      confidence_reason: "7 of 8 checklist items present; 3 usable annual records.",
      material_conflict: false,
      data_issues: [],
      notes: [],
    },
    executive_verdict: {
      stance: "attractive",
      commitment: "Margins are stable and leverage is low against steady revenue growth.",
      deciding_factors: [
        { claim: "Operating margin held near 12% across three years.", tag: "calc", evidence: "profitability.operatingMargin 0.12" },
        { claim: "Revenue grew 10% year on year.", tag: "fact", evidence: "growth.revenueGrowth 0.1" },
      ],
      falsifier: "A quarter of margin compression below 9% operating margin.",
    },
    business: taggedStatement({ tag: "fact" }),
    performance: {
      revenue_trend: taggedStatement(),
      earnings_trend: taggedStatement(),
      growth_supports_earnings: "yes",
    },
    profitability: taggedStatement({ direction: "stable" }),
    per_share: taggedStatement({ dilution: "no" }),
    balance_sheet: taggedStatement({ leverage: "low" }),
    cash_flow: taggedStatement({ assessable: "yes" }),
    capital_efficiency: taggedStatement({ assessable: "yes" }),
    dividend: taggedStatement({ sustainability: "conservative" }),
    valuation: taggedStatement({ read: "supported" }),
    historical_trend: {
      statement: "Revenue, operating income and net income all rose across the three reported years.",
      tag: "fact",
      evidence: "annual[2].revenue 9000000000000 vs annual[0].revenue 8000000000000",
      strongest_period: "2026-03-31",
      weakest_period: "2024-03-31",
      inflections: [],
    },
    positive_signals: [
      { claim: "Free cash flow covers the dividend several times over.", tag: "calc", evidence: "health.freeCashflow 300000000000" },
    ],
    red_flags: [],
    scenarios: [
      { id: "bull", view: "Margins expand as refining spreads improve.", requires: "Operating margin above 13%.", falsifier: "Margin falls below 10%." },
      { id: "base", view: "Margins hold near current levels.", requires: "Revenue growth continues near 10%.", falsifier: "Revenue growth turns negative." },
      { id: "bear", view: "Margins compress on rising input costs.", requires: "Operating margin below 9%.", falsifier: "Margin recovers above 11%." },
    ],
    missing_information: [],
    summary: "A stable, moderately levered business with consistent margins and growth.",
    ...overrides,
  };
}

describe("FundamentalsAiSchema", () => {
  it("accepts a clean, internally-consistent response", () => {
    const result = FundamentalsAiSchema.safeParse(validResponse());
    expect(result.success).toBe(true);
  });

  it("rejects material_conflict true paired with confidence high", () => {
    const result = FundamentalsAiSchema.safeParse(
      validResponse({ meta: { ...validResponse().meta, material_conflict: true, confidence: "high" } }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts material_conflict true paired with a capped confidence", () => {
    const result = FundamentalsAiSchema.safeParse(
      validResponse({ meta: { ...validResponse().meta, material_conflict: true, confidence: "medium" } }),
    );
    expect(result.success).toBe(true);
  });

  it.each([
    "pristine",
    "eliminate balance-sheet risk",
    "risk-free",
    "guaranteed",
    "bulletproof",
    "severe balance-sheet protection",
  ])("rejects the banned phrase %j wherever it appears in the response", (phrase) => {
    const result = FundamentalsAiSchema.safeParse(
      validResponse({ summary: `A business with a ${phrase} outlook overall.` }),
    );
    expect(result.success).toBe(false);
  });

  it("is case-insensitive when scanning for banned phrases", () => {
    const result = FundamentalsAiSchema.safeParse(
      validResponse({ summary: "This company has a PRISTINE balance sheet." }),
    );
    expect(result.success).toBe(false);
  });

  it("does not false-positive on ordinary, non-absolute language", () => {
    const result = FundamentalsAiSchema.safeParse(
      validResponse({ summary: "A solid balance sheet with low leverage and steady cash generation." }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a deciding_factor claiming current margin compression when direction is stable", () => {
    const base = validResponse();
    const result = FundamentalsAiSchema.safeParse(
      validResponse({
        executive_verdict: {
          ...base.executive_verdict,
          deciding_factors: [
            { claim: "Operating margin is compressing, indicating margin compression.", tag: "inf", evidence: "profitability.operatingMargin 0.12" },
            { claim: "Revenue grew 10% year on year.", tag: "fact", evidence: "growth.revenueGrowth 0.1" },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts the same margin-compression wording when direction is deteriorating", () => {
    const base = validResponse();
    const result = FundamentalsAiSchema.safeParse(
      validResponse({
        profitability: { ...base.profitability, direction: "deteriorating" },
        executive_verdict: {
          ...base.executive_verdict,
          deciding_factors: [
            { claim: "Operating margin has been compressing for three straight years.", tag: "calc", evidence: "profitability.operatingMargin 0.09" },
            { claim: "Revenue grew 10% year on year.", tag: "fact", evidence: "growth.revenueGrowth 0.1" },
          ],
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("allows a bear scenario to describe hypothetical margin compression regardless of direction", () => {
    // The fixture's own bear scenario already says "Margins compress on
    // rising input costs" with direction "stable" — scenarios are
    // hypothetical branches, not claims about the present, so this must pass.
    const result = FundamentalsAiSchema.safeParse(validResponse());
    expect(result.success).toBe(true);
  });

  it("rejects a calc-tagged implied share count with no derivation wording", () => {
    const base = validResponse();
    const result = FundamentalsAiSchema.safeParse(
      validResponse({
        per_share: {
          ...base.per_share,
          tag: "calc",
          statement: "The company had a diluted share count of 6.9 billion in FY2026.",
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a calc-tagged implied share count when the statement says 'implied'", () => {
    const base = validResponse();
    const result = FundamentalsAiSchema.safeParse(
      validResponse({
        per_share: {
          ...base.per_share,
          tag: "calc",
          statement: "The implied diluted share count for FY2026 was approximately 6.9 billion.",
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("does not flag a fact-tagged per_share statement that never mentions a share count", () => {
    const base = validResponse();
    const result = FundamentalsAiSchema.safeParse(
      validResponse({
        per_share: { ...base.per_share, tag: "fact", statement: "Diluted EPS was 58.3 for FY2026." },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a scenario threshold pairing an expansion word with a 'below' negative floor", () => {
    const base = validResponse();
    const result = FundamentalsAiSchema.safeParse(
      validResponse({
        scenarios: [
          base.scenarios[0],
          base.scenarios[1],
          {
            id: "bear",
            view: "Margins come under pressure from rising costs.",
            requires: "Operating margin expanding below -7%.",
            falsifier: "Margin recovers above 11%.",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a coherent bear scenario pairing compression with a 'below' threshold", () => {
    const result = FundamentalsAiSchema.safeParse(validResponse());
    expect(result.success).toBe(true);
  });

  // Regression coverage for a false-positive an earlier, broader version of
  // findContradictoryScenarioThreshold produced: it assumed "improve/expand"
  // always pairs with "above" and "decline/contract" always pairs with
  // "below", which holds for margins but is backwards for leverage and debt
  // ratios, where lower is better. That version rejected all of these,
  // breaking every analysis whose scenarios mentioned leverage at all.
  it.each([
    "Debt-to-equity improving to below 40%.",
    "Leverage deteriorating above 100% debt-to-equity.",
    "Revenue growth increasing while staying below 15%.",
    "Quick ratio declining below 1.0 signaling liquidity stress.",
  ])("does not flag ordinary non-margin scenario wording: %j", (text) => {
    const base = validResponse();
    const result = FundamentalsAiSchema.safeParse(
      validResponse({
        scenarios: [
          base.scenarios[0],
          base.scenarios[1],
          { id: "bear", view: "Balance sheet metrics move against the company.", requires: text, falsifier: "Metrics reverse." },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});
