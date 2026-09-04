/**
 * The canonical shape of one fundamentals AI analysis result.
 *
 * Mirrors "THE JSON SHAPE" in apps/api/src/prompts/fundamentals-analysis.ts
 * exactly, field for field — there is one prompt here, not a vision/series
 * union like AnalysisResult in chart-analysis.ts, so this needs no
 * normalisation step, only validation.
 *
 * This lives in packages/shared because it is the contract on both sides of
 * the wire: apps/api validates the model's json into it and stores it in
 * `analyses.fundamentals_result`, and apps/web reads that column back and
 * renders it. A divergence between the two must be a compile error.
 *
 * The zod schema that parses the raw model output into this shape lives in
 * apps/api/src/services/fundamentals-analysis-schema.ts, next to the prompt
 * it mirrors.
 */

/** How a claim is grounded. The prompt's four-value set; `business` alone
 *  never emits "calc" (see FundamentalsBusiness). */
export type FundamentalsTag = 'fact' | 'calc' | 'inf' | 'unk';

/** `business` has no arithmetic to derive — only a report or an inference. */
export type FundamentalsBusinessTag = 'fact' | 'inf' | 'unk';

/** deciding_factors / positive_signals / red_flags never use "unk" — an
 *  unknowable claim belongs in missing_information instead. */
export type FundamentalsClaimTag = 'fact' | 'calc' | 'inf';

export type FundamentalsConfidence = 'high' | 'medium' | 'low';

export type FundamentalsStance = 'attractive' | 'not_attractive' | 'mixed';

export type FundamentalsGrowthSupportsEarnings = 'yes' | 'no' | 'mixed' | 'unk';

export type FundamentalsProfitabilityDirection =
  | 'improving'
  | 'stable'
  | 'deteriorating'
  | 'volatile'
  | 'unk';

export type FundamentalsDilution = 'yes' | 'no' | 'unk';

export type FundamentalsLeverage = 'zero' | 'low' | 'moderate' | 'high' | 'unk';

export type FundamentalsAssessable = 'yes' | 'no';

export type FundamentalsDividendSustainability =
  | 'conservative'
  | 'aggressive'
  | 'none'
  | 'unk';

export type FundamentalsValuationRead = 'supported' | 'stretched' | 'compressed' | 'unk';

export type FundamentalsScenarioId = 'bull' | 'base' | 'bear';

export interface FundamentalsAnalysisMeta {
  symbol: string;
  /** 0 to 8 — see the CONFIDENCE checklist in the prompt. */
  completeness: number;
  confidence: FundamentalsConfidence;
  confidence_reason: string;
  material_conflict: boolean;
  data_issues: string[];
  notes: string[];
}

export interface FundamentalsClaim {
  claim: string;
  tag: FundamentalsClaimTag;
  evidence: string;
}

export interface FundamentalsExecutiveVerdict {
  stance: FundamentalsStance;
  commitment: string;
  /** 2 to 4 items, never empty. */
  deciding_factors: FundamentalsClaim[];
  falsifier: string;
}

export interface FundamentalsBusiness {
  statement: string;
  tag: FundamentalsBusinessTag;
  evidence: string;
}

/** The shape shared by most sections below: a grounded statement plus one
 *  section-specific enum verdict. */
export interface FundamentalsTaggedStatement {
  statement: string;
  tag: FundamentalsTag;
  evidence: string;
}

export interface FundamentalsPerformance {
  revenue_trend: FundamentalsTaggedStatement;
  earnings_trend: FundamentalsTaggedStatement;
  growth_supports_earnings: FundamentalsGrowthSupportsEarnings;
}

export interface FundamentalsProfitabilitySection extends FundamentalsTaggedStatement {
  direction: FundamentalsProfitabilityDirection;
}

export interface FundamentalsPerShareSection extends FundamentalsTaggedStatement {
  dilution: FundamentalsDilution;
}

export interface FundamentalsBalanceSheetSection extends FundamentalsTaggedStatement {
  leverage: FundamentalsLeverage;
}

export interface FundamentalsCashFlowSection extends FundamentalsTaggedStatement {
  assessable: FundamentalsAssessable;
}

export interface FundamentalsCapitalEfficiencySection extends FundamentalsTaggedStatement {
  assessable: FundamentalsAssessable;
}

export interface FundamentalsDividendSection extends FundamentalsTaggedStatement {
  sustainability: FundamentalsDividendSustainability;
}

export interface FundamentalsValuationSection extends FundamentalsTaggedStatement {
  read: FundamentalsValuationRead;
}

export interface FundamentalsHistoricalTrendSection extends FundamentalsTaggedStatement {
  /** The chosen record's asOfDate verbatim, or null when annual[] is empty. */
  strongest_period: string | null;
  weakest_period: string | null;
  /** 0 to 4 items, each "asOfDate: what reversed". */
  inflections: string[];
}

export interface FundamentalsScenario {
  id: FundamentalsScenarioId;
  view: string;
  requires: string;
  falsifier: string;
}

export interface FundamentalsMissingInformationItem {
  item: string;
  impact: string;
}

export interface FundamentalsAnalysisResult {
  meta: FundamentalsAnalysisMeta;
  executive_verdict: FundamentalsExecutiveVerdict;
  business: FundamentalsBusiness;
  performance: FundamentalsPerformance;
  profitability: FundamentalsProfitabilitySection;
  per_share: FundamentalsPerShareSection;
  balance_sheet: FundamentalsBalanceSheetSection;
  cash_flow: FundamentalsCashFlowSection;
  capital_efficiency: FundamentalsCapitalEfficiencySection;
  dividend: FundamentalsDividendSection;
  valuation: FundamentalsValuationSection;
  historical_trend: FundamentalsHistoricalTrendSection;
  /** 0 to 5 items. Never tagged "unk" — see FundamentalsClaimTag. */
  positive_signals: FundamentalsClaim[];
  /** 0 to 5 items. */
  red_flags: FundamentalsClaim[];
  /** Exactly 3 entries: one each of "bull", "base", "bear". */
  scenarios: FundamentalsScenario[];
  /** 0 to 6 items. */
  missing_information: FundamentalsMissingInformationItem[];
  /** Two or three sentences, pure prose, no numbers. */
  summary: string;
}
