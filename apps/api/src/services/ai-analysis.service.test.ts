import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "openai";
import { deriveFundamentals } from "./fundamentals/index.js";

/** Eight contiguous March-quarter ends, oldest first. */
const EIGHT_QUARTER_ENDS = [
  "2024-09-30",
  "2024-12-31",
  "2025-03-31",
  "2025-06-30",
  "2025-09-30",
  "2025-12-31",
  "2026-03-31",
  "2026-06-30",
];
import { callDirectionFor } from "@tradesathi/shared";

const create = vi.fn();
const fallbackCreate = vi.fn();

// A two-provider chain: a primary and one fallback, so the failover path is
// exercised by the same tests that cover the single-provider behaviour.
vi.mock("../lib/ai-client.js", () => ({
  aiProviders: [
    {
      name: "primary",
      model: "test-model",
      maxTokens: 4096,
      inputCostPerM: 2,
      outputCostPerM: 10,
      supportsVision: true,
      client: { chat: { completions: { create } } },
    },
    {
      name: "fallback",
      model: "fallback-model",
      maxTokens: 8192,
      inputCostPerM: 1,
      outputCostPerM: 4,
      supportsVision: false,
      client: { chat: { completions: { create: fallbackCreate } } },
    },
  ],
}));
vi.mock("../lib/env.js", () => ({ env: {} }));

const mockFrom = vi.fn();
const mockCallRpc = vi.fn();
vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: mockFrom },
  callRpc: mockCallRpc,
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const {
  AnalysisFailure,
  runSeriesAnalysis,
  runVisualAnalysis,
  runFundamentalsAnalysis,
  reclaimStrandedAnalyses,
} = await import("./ai-analysis.service.js");

const CONTEXT = {
  symbol: "RELIANCE",
  name: "Reliance Industries",
  exchange: "NSE",
  timeframeLabel: "1D · 90d",
  intervalMinutes: 1440,
};

const CANDLES = [
  { timestamp: "2026-08-31", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
];

/** One coherent long scenario, matching prompts/candle-analysis.ts. */
const SCENARIO = {
  id: "s1",
  trigger: "close_above",
  trigger_low: 1440,
  trigger_high: 1448,
  direction: "long",
  invalidation: 1398,
  target: 1520,
  target_basis: "prior_swing",
  obstacle: null,
  p_target_before_invalidation: 0.38,
  horizon_candles: 12,
};

/**
 * A schema-valid candle-series response, per prompts/candle-analysis.ts.
 * Tests override one branch at a time to isolate what they are asserting.
 */
function seriesPayload(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      symbol_text: "RELIANCE",
      chart_type: "candlestick",
      axis_state: "calibrated",
      candles_visible: 120,
      volume_pane: true,
      corporate_action_suspected: false,
      close_at_generation: 1402.5,
      notes: [],
    },
    identity: {
      symbol_text: "RELIANCE",
      resolved_symbol: "RELIANCE.NS",
      instrument_type: "equity",
      timeframe: "d1",
      expiry_days: "unknown",
    },
    structure: {
      state: "uptrend",
      clarity: "high",
      range_position: 0.72,
      levels: [
        { low: 1402, high: 1408.5, kind: "support", touches: 3, dist_atr: 0.4, source: "computed" },
      ],
    },
    regime: {
      atr_pct: 1.8,
      atr_percentile_window: 0.62,
      volume_vs_median: 1.4,
      persistence: "trending",
      liquidity_ok: "unknown",
    },
    setup: { format: "conditional", abstain_reason: null, scenarios: [SCENARIO] },
    falsifier: "A daily close back below 1398 on above-median volume.",
    base_rate: { n_analogues: "unknown", hit_rate: "unknown", definition: null },
    summary: "Price is pressing the top of its range after a steady advance.",
    ...overrides,
  };
}

/** The same, for prompts/chart-analysis.ts — a screenshot read. */
function visionPayload(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      chart_id: "c_img_001",
      chart_type: "candlestick",
      axis_state: "calibrated",
      candles_visible: 90,
      volume_pane: true,
      price_read_error_pct: 0.2,
      blockers: [],
    },
    identity: {
      symbol_text: "BTCUSD",
      resolved_symbol: "unknown",
      instrument_type: "crypto",
      timeframe: "h4",
      expiry_days: "unknown",
    },
    structure: {
      state: "range",
      clarity: "medium",
      range_position: 0.4,
      levels: [
        { low: 60900, high: 61100, kind: "support", touches: 4, dist_atr: 0.6, source: "vision" },
      ],
    },
    regime: {
      atr_pct: 1.1,
      atr_percentile_1y: "unknown",
      volume_vs_median: 0.9,
      persistence: "choppy",
      liquidity_ok: "unknown",
    },
    setup: { format: "conditional", abstain_reason: null, scenarios: [SCENARIO] },
    falsifier: "A four-hour close beneath the lower edge of the zone.",
    base_rate: { n_analogues: "unknown", hit_rate: "unknown", definition: null },
    summary: "The market is ranging between two well-tested edges.",
    ...overrides,
  };
}

/**
 * A derived-fundamentals input for runFundamentalsAnalysis.
 *
 * Built through the real derivation path from synthetic raw statements, so
 * the facts the prompt hands the model — and the semantic validator checks it
 * copied — are the ones the production code would compute, not hand-written
 * constants that could drift away from it.
 */
function fundamentalsInput() {
  const quarters = EIGHT_QUARTER_ENDS.map((periodEnd, i) => ({
    periodEnd,
    months: 3 as const,
    basis: "consolidated" as const,
    currency: "INR",
    source: "yahoo" as const,
    filingDate: null,
    revenue: 2_000_000_000_000 + i * 50_000_000_000,
    totalIncome: 2_000_000_000_000 + i * 50_000_000_000,
    otherIncome: null,
    costOfRevenue: null,
    grossProfit: 600_000_000_000 + i * 15_000_000_000,
    operatingIncome: 240_000_000_000 + i * 6_000_000_000,
    pretaxIncome: 230_000_000_000 + i * 6_000_000_000,
    netIncome: 160_000_000_000 + i * 4_000_000_000,
    dilutedShares: 6_766_000_000,
    operatingCashFlow: 220_000_000_000,
    capex: 60_000_000_000,
    dividendsPaid: 14_000_000_000,
    equity: 2_900_000_000_000,
    totalDebt: 1_200_000_000_000,
    cash: 200_000_000_000,
    sharesOutstanding: 6_766_000_000,
  }));

  const statements = {
    quarterly: quarters,
    annual: [],
    spot: {
      price: 1_400,
      asOf: "2026-09-04T10:00:00.000Z",
      marketCap: 18_000_000_000_000,
      currency: "INR",
      financialCurrency: "INR",
      dividendDeclaredPerShare: 5.5,
      dividendYield: 0.0039,
      mostRecentQuarter: "2026-06-30",
    },
    forward: [{ epsAvg: 70, periodEnd: "2027-03-31" }],
    corporateActions: [],
  };

  return {
    instrument: { id: "i1", symbol: "RELIANCE", name: "Reliance Industries", exchange: "NSE" },
    derived: deriveFundamentals(statements, "NSE"),
  };
}

const FUNDAMENTALS_INPUT = fundamentalsInput();

/** One `{statement, tag, evidence}` section, plus its verdict key. */
const taggedStatement = (extra: Record<string, unknown> = {}) => ({
  statement: "A statement grounded in the payload.",
  tag: "fact",
  evidence: "revenue 8500000000000 (TTM 2025-07-01..2026-06-30)",
  ...extra,
});

/** A schema-valid response, per prompts/fundamentals-analysis.ts's json shape. */
function fundamentalsPayload(overrides: Record<string, unknown> = {}) {
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
      commitment: "Margins are stable and leverage is moderate against steady revenue growth.",
      deciding_factors: [
        { claim: "Operating margin held near 12% across three years.", tag: "calc", evidence: "profitability.operatingMargin 0.12" },
        { claim: "Revenue grew 10% year on year.", tag: "fact", evidence: "growth.revenueGrowth 0.1" },
      ],
      falsifier: "Operating margin compressing below 9.00%.",
    },
    business: taggedStatement({ tag: "fact" }),
    performance: {
      revenue_trend: taggedStatement(),
      earnings_trend: taggedStatement(),
      growth_supports_earnings: "yes",
    },
    profitability: taggedStatement({ direction: "stable" }),
    per_share: taggedStatement({ dilution: "no" }),
    // "low", not "moderate": FUNDAMENTALS_INPUT's health.debtToEquity is
    // 41.2, which the leverage-reconciliation guard in ai-analysis.service.ts
    // bands to "low" (below 50) — keeping this fixture consistent with that
    // arithmetic avoids the guard silently rewriting it in every test below.
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
      // Every threshold named here is one of the report's own four — see
      // buildThresholds. A scenario naming any other number is rejected.
      { id: "bull", view: "Margins expand as refining spreads improve.", requires: "Cash conversion holding above 70.33%.", falsifier: "Operating margin falls below 9.00%." },
      { id: "base", view: "Margins hold near current levels.", requires: "Revenue growth holding above 4.82%.", falsifier: "Revenue growth turns negative." },
      { id: "bear", view: "Margins compress on rising input costs.", requires: "Operating margin falling below 9.00%.", falsifier: "Gross debt to equity stays under 82.76%." },
    ],
    missing_information: [],
    summary: "A stable, moderately levered business with consistent margins and growth.",
    ...overrides,
  };
}

function completion(payload: unknown, promptTokens = 1_000, completionTokens = 500) {
  return {
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

beforeEach(() => {
  create.mockReset();
  fallbackCreate.mockReset();
  mockFrom.mockReset();
  mockCallRpc.mockReset();
});

describe("setup validation", () => {
  it("accepts an abstention, which the prompts make a deliberately common answer", async () => {
    create.mockResolvedValue(
      completion(
        seriesPayload({
          setup: { format: "none", abstain_reason: "price_mid_range", scenarios: [] },
        }),
      ),
    );

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.setup.format).toBe("none");
    expect(outcome.result.setup.abstain_reason).toBe("price_mid_range");
    // 'hold' is how public.call_direction spells an abstention.
    expect(callDirectionFor(outcome.result)).toBe("hold");
    // One attempt only: a valid response must never be retried.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["long", "short"] as const)("passes a %s scenario through", async (direction) => {
    // The mirror geometry: a short's invalidation sits above its trigger and
    // its target below, which is exactly what the schema enforces.
    const scenario =
      direction === "long"
        ? SCENARIO
        : { ...SCENARIO, direction, trigger: "close_below", invalidation: 1500, target: 1350 };
    create.mockResolvedValue(
      completion(
        seriesPayload({ setup: { format: "conditional", abstain_reason: null, scenarios: [scenario] } }),
      ),
    );

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.setup.scenarios[0].direction).toBe(direction);
    expect(callDirectionFor(outcome.result)).toBe(direction);
  });

  it("stores no direction for a two-scenario read, which has no single answer", async () => {
    const short = { ...SCENARIO, id: "s2", direction: "short", trigger: "close_below", invalidation: 1500, target: 1350 };
    create.mockResolvedValue(
      completion(
        seriesPayload({
          setup: { format: "two_scenario", abstain_reason: null, scenarios: [SCENARIO, short] },
        }),
      ),
    );

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.setup.scenarios).toHaveLength(2);
    expect(callDirectionFor(outcome.result)).toBeNull();
  });

  it("rejects a direction outside the contract", async () => {
    // Both providers: an out-of-contract value is the model breaking the
    // contract, not a provider outage, so the chain runs out and the schema
    // failure is what surfaces.
    const payload = seriesPayload({
      setup: {
        format: "conditional",
        abstain_reason: null,
        scenarios: [{ ...SCENARIO, direction: "buy" }],
      },
    });
    create.mockResolvedValue(completion(payload));
    fallbackCreate.mockResolvedValue(completion(payload));

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("rejects a scenario whose stop sits on the same side as its target", async () => {
    // A "long" invalidated ABOVE its trigger is not a near miss — it would
    // render as a precise, confident, impossible trade.
    const payload = seriesPayload({
      setup: {
        format: "conditional",
        abstain_reason: null,
        scenarios: [{ ...SCENARIO, invalidation: 1460 }],
      },
    });
    create.mockResolvedValue(completion(payload));
    fallbackCreate.mockResolvedValue(completion(payload));

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("rejects a probability above the ceiling both prompts impose", async () => {
    // 0.55 is the stated bound: "setup hit rates above this are not supported
    // by evidence". A model returning 0.8 has abandoned the discipline the
    // whole prompt is built around.
    const payload = seriesPayload({
      setup: {
        format: "conditional",
        abstain_reason: null,
        scenarios: [{ ...SCENARIO, p_target_before_invalidation: 0.8 }],
      },
    });
    create.mockResolvedValue(completion(payload));
    fallbackCreate.mockResolvedValue(completion(payload));

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("rejects forward numbers on an abstention", async () => {
    const payload = seriesPayload({
      setup: { format: "none", abstain_reason: "price_mid_range", scenarios: [SCENARIO] },
    });
    create.mockResolvedValue(completion(payload));
    fallbackCreate.mockResolvedValue(completion(payload));

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });
});

describe("normalisation", () => {
  it("turns every \"unknown\" into null", async () => {
    create.mockResolvedValue(
      completion(
        seriesPayload({
          regime: {
            atr_pct: "unknown",
            atr_percentile_window: "unknown",
            volume_vs_median: "unknown",
            persistence: "unknown",
            liquidity_ok: "unknown",
          },
        }),
      ),
    );

    const { regime } = (await runSeriesAnalysis(CANDLES, CONTEXT)).result;

    expect(regime).toEqual({
      atr_pct: null,
      atr_percentile: null,
      volume_vs_median: null,
      persistence: null,
      liquidity_ok: null,
    });
  });

  it("drops a base rate counted off too few analogues", async () => {
    // "If n_analogues < 20, all three fields: unknown." A hit rate off eleven
    // samples is noise wearing the clothes of evidence.
    create.mockResolvedValue(
      completion(
        seriesPayload({
          base_rate: { n_analogues: 11, hit_rate: 0.64, definition: "closes above the 20-bar high" },
        }),
      ),
    );

    expect((await runSeriesAnalysis(CANDLES, CONTEXT)).result.base_rate).toEqual({
      n_analogues: null,
      hit_rate: null,
      definition: null,
    });
  });

  it("keeps a base rate with enough analogues behind it", async () => {
    create.mockResolvedValue(
      completion(
        seriesPayload({
          base_rate: { n_analogues: 34, hit_rate: 0.41, definition: "closes above the 20-bar high" },
        }),
      ),
    );

    expect((await runSeriesAnalysis(CANDLES, CONTEXT)).result.base_rate).toEqual({
      n_analogues: 34,
      hit_rate: 0.41,
      definition: "closes above the 20-bar high",
    });
  });

  it("keeps only the three nearest level zones", async () => {
    const zone = (low: number) => ({
      low,
      high: low + 5,
      kind: "support",
      touches: 2,
      dist_atr: 0.5,
      source: "computed",
    });
    create.mockResolvedValue(
      completion(
        seriesPayload({
          structure: {
            state: "uptrend",
            clarity: "high",
            range_position: 0.5,
            levels: [zone(1400), zone(1380), zone(1360), zone(1340)],
          },
        }),
      ),
    );

    const { levels } = (await runSeriesAnalysis(CANDLES, CONTEXT)).result.structure;

    // Sliced, not rejected: the prompts order zones nearest-close-first, so
    // the tail is exactly what the cap was asking the model to leave out.
    expect(levels.map((level) => level.low)).toEqual([1400, 1380, 1360]);
  });

  it("rejects an inverted level zone", async () => {
    const payload = seriesPayload({
      structure: {
        state: "uptrend",
        clarity: "high",
        range_position: 0.5,
        levels: [
          { low: 1420, high: 1400, kind: "support", touches: 2, dist_atr: 0.3, source: "computed" },
        ],
      },
    });
    create.mockResolvedValue(completion(payload));
    fallbackCreate.mockResolvedValue(completion(payload));

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("drops an unrecognised blocker rather than failing the whole read", async () => {
    // A blocker is a caption on the answer, not the answer. Losing one is a
    // far smaller harm than failing an otherwise good analysis.
    create.mockResolvedValue(
      completion(
        visionPayload({
          meta: {
            chart_id: "c_img_001",
            chart_type: "candlestick",
            axis_state: "partial",
            candles_visible: 90,
            volume_pane: true,
            price_read_error_pct: 0.4,
            blockers: ["axis_partial", "moon_phase_adverse"],
          },
        }),
      ),
    );

    const outcome = await runVisualAnalysis(Buffer.from("png"), "image/png");

    expect(outcome.result.meta.blockers).toEqual(["axis_partial"]);
  });
});

describe("the two prompts have two schemas", () => {
  it("validates a screenshot read on the image path", async () => {
    create.mockResolvedValue(completion(visionPayload()));

    const outcome = await runVisualAnalysis(Buffer.from("png"), "image/png");

    expect(outcome.result.kind).toBe("vision");
    // Vision cannot compute a one-year ATR percentile, so the prompt pins it
    // to "unknown" and normalisation nulls it.
    expect(outcome.result.regime.atr_percentile).toBeNull();
    expect(outcome.result.meta.close_at_generation).toBeNull();
  });

  it("rejects a candle-series response on the image path", async () => {
    // The series payload claims an exact close and a corporate-action check,
    // neither of which a screenshot read can honestly produce. Accepting it
    // here would store a computed-grade result from a pixel read.
    create.mockResolvedValue(completion(seriesPayload()));

    await expect(runVisualAnalysis(Buffer.from("png"), "image/png")).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("marks a series read as computed", async () => {
    create.mockResolvedValue(completion(seriesPayload()));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.kind).toBe("computed");
    expect(outcome.result.meta.close_at_generation).toBe(1402.5);
  });

  it("reports the token usage the provider returned", async () => {
    create.mockResolvedValue(completion(seriesPayload()));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.inputTokens).toBe(1_000);
    expect(outcome.outputTokens).toBe(500);
  });
});

describe("cost estimation", () => {
  it("prices tokens at the rates of the provider that served the call", async () => {
    // 1M input at $2 + 0.5M output at $10, the primary's configured rates.
    create.mockResolvedValue(completion(seriesPayload(), 1_000_000, 500_000));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.costUsd).toBeCloseTo(7, 10);
    expect(outcome.modelId).toBe("test-model");
  });

  it("prices a failed-over call at the FALLBACK's rates, not the primary's", async () => {
    create.mockRejectedValue(new Error("upstream down"));
    fallbackCreate.mockResolvedValue(completion(seriesPayload(), 1_000_000, 500_000));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    // 1M at $1 + 0.5M at $4 — charging the primary's rates here would
    // silently misreport margin on every failed-over run.
    expect(outcome.costUsd).toBeCloseTo(3, 10);
    expect(outcome.modelId).toBe("fallback-model");
  });

  it("is zero when the provider reported no usage", async () => {
    create.mockResolvedValue(completion(seriesPayload(), 0, 0));

    expect((await runSeriesAnalysis(CANDLES, CONTEXT)).costUsd).toBe(0);
  });
});

describe("provider fallback", () => {
  it("falls back to the next provider when the primary keeps failing", async () => {
    create.mockRejectedValue(new Error("upstream down"));
    fallbackCreate.mockResolvedValue(completion(seriesPayload()));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.setup.format).toBe("conditional");
    // The primary gets its own two attempts before the chain moves on.
    expect(create).toHaveBeenCalledTimes(2);
    expect(fallbackCreate).toHaveBeenCalledTimes(1);
  });

  it("never touches the fallback when the primary succeeds", async () => {
    create.mockResolvedValue(completion(seriesPayload()));

    await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it("once the chain is exhausted, prefers an infrastructure failure over a content one", async () => {
    // The primary's plain network error is reported as api_error; the
    // fallback then hands back empty content, reported as invalid_json. The
    // infrastructure failure is the more actionable of the two — "invalid
    // json" invites a pointless retry against a provider that was never
    // reached in the first place — so it is the one surfaced, even though it
    // was not the last provider tried.
    create.mockRejectedValue(new Error("upstream down"));
    fallbackCreate.mockResolvedValue({ choices: [{ message: { content: "" } }] });

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "api_error",
    });
  });

  it("surfaces a rate limit over a later content failure, wherever in the chain it happened", async () => {
    // Reproduces a live incident: a free-tier provider's daily quota (20
    // requests/day/model) is exhausted, the chain falls through to the one
    // remaining provider, and that provider produces a genuine but unrelated
    // schema mismatch. Reporting the schema failure told the user "try
    // again, this is transient" for a problem that would not resolve on its
    // own — the account was simply out of quota.
    const rateLimitError = new RateLimitError(429, { message: "quota exceeded" }, "quota exceeded", new Headers());
    create.mockRejectedValue(rateLimitError);
    fallbackCreate.mockResolvedValue({ choices: [{ message: { content: "not json" } }] });

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("skips text-only providers on the image path rather than failing on them", async () => {
    // The fallback is supportsVision: false, so an image request must never
    // reach it — a text-only model cannot read a chart screenshot at all.
    create.mockRejectedValue(new Error("upstream down"));

    await expect(
      runVisualAnalysis(Buffer.from("png"), "image/png"),
    ).rejects.toBeInstanceOf(AnalysisFailure);
    expect(fallbackCreate).not.toHaveBeenCalled();
  });
});

describe("fundamentals analysis", () => {
  it("accepts a schema-valid response", async () => {
    create.mockResolvedValue(completion(fundamentalsPayload()));

    const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

    expect(outcome.result.executive_verdict.stance).toBe("attractive");
    expect(outcome.result.scenarios).toHaveLength(3);
    // One attempt only: a valid response must never be retried.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-contract stance value", async () => {
    const payload = fundamentalsPayload({
      executive_verdict: {
        stance: "bullish",
        commitment: "x",
        deciding_factors: [
          { claim: "a", tag: "fact", evidence: "e" },
          { claim: "b", tag: "fact", evidence: "e" },
        ],
        falsifier: "x",
      },
    });
    create.mockResolvedValue(completion(payload));
    fallbackCreate.mockResolvedValue(completion(payload));

    await expect(runFundamentalsAnalysis(FUNDAMENTALS_INPUT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("rejects scenarios missing one of bull/base/bear", async () => {
    const payload = fundamentalsPayload();
    payload.scenarios = [payload.scenarios[0], payload.scenarios[1], payload.scenarios[1]];
    create.mockResolvedValue(completion(payload));
    fallbackCreate.mockResolvedValue(completion(payload));

    await expect(runFundamentalsAnalysis(FUNDAMENTALS_INPUT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("never sends an image — this prompt is text/JSON only", async () => {
    // The fallback provider is supportsVision: false; if this path ever
    // requested vision it would be dropped from the chain and never called.
    create.mockRejectedValue(new Error("upstream down"));
    fallbackCreate.mockResolvedValue(completion(fundamentalsPayload()));

    const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

    expect(outcome.modelId).toBe("fallback-model");
  });

  describe("semantic validation replaces the post-hoc reconcilers", () => {
    // Four reconcilers used to sit downstream of the model, rewriting its
    // leverage band, growth verdict, dividend sustainability and executive
    // stance. Three of those verdicts are now computed upstream and handed to
    // the model to copy; a mismatch is a rejected response, not a silent
    // patch. These tests assert the rejection.

    it("rejects a leverage band that disagrees with the derived one", async () => {
      // The derived payload bands to "low"; the model says "high".
      const payload = completion(
        fundamentalsPayload({ balance_sheet: taggedStatement({ leverage: "high" }) }),
      );
      create.mockResolvedValue(payload);
      fallbackCreate.mockResolvedValue(payload);

      await expect(runFundamentalsAnalysis(FUNDAMENTALS_INPUT)).rejects.toMatchObject({
        code: "schema_validation",
      });
    });

    it("accepts the derived band when the model copies it", async () => {
      create.mockResolvedValue(completion(fundamentalsPayload()));
      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);
      expect(outcome.result.balance_sheet.leverage).toBe("low");
    });

    it("allows a sector-structural unk to override a derived band", async () => {
      // Leverage is not a meaningful measure for a lender whatever the
      // arithmetic says, so "unk" is the one legitimate override.
      create.mockResolvedValue(
        completion(fundamentalsPayload({ balance_sheet: taggedStatement({ leverage: "unk" }) })),
      );
      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);
      expect(outcome.result.balance_sheet.leverage).toBe("unk");
    });

    it("rejects a growth verdict that disagrees with the derived one", async () => {
      const payload = completion(
        fundamentalsPayload({
            performance: {
              revenue_trend: taggedStatement(),
              earnings_trend: taggedStatement(),
              growth_supports_earnings: "no",
            },
        }),
      );
      create.mockResolvedValue(payload);
      fallbackCreate.mockResolvedValue(payload);

      await expect(runFundamentalsAnalysis(FUNDAMENTALS_INPUT)).rejects.toMatchObject({
        code: "schema_validation",
      });
    });

    it("rejects an attractive stance that contradicts its own sections", async () => {
      // Observed in production: "attractive" alongside a fact-tagged red flag
      // and a stretched read. It used to be silently downgraded to "mixed";
      // now the response is regenerated instead.
      const payload = completion(
        fundamentalsPayload({
            red_flags: [
              {
                claim: "Free cash flow fell year on year.",
                tag: "fact",
                evidence: "fcf 300000000000",
              },
            ],
        }),
      );
      create.mockResolvedValue(payload);
      fallbackCreate.mockResolvedValue(payload);

      await expect(runFundamentalsAnalysis(FUNDAMENTALS_INPUT)).rejects.toMatchObject({
        code: "schema_validation",
      });
    });

    it("leaves a non-attractive stance alone even with a fact-tagged red flag", async () => {
      create.mockResolvedValue(
        completion(
          fundamentalsPayload({
            executive_verdict: {
              stance: "mixed",
              commitment:
                "Margins are stable and leverage is moderate against steady revenue growth.",
              deciding_factors: [
                { claim: "Operating margin held steady.", tag: "calc", evidence: "operatingMargin 0.12" },
                { claim: "Revenue grew year on year.", tag: "fact", evidence: "revenueGrowthFy 0.1" },
              ],
              falsifier: "Operating margin falls below 9.00%.",
            },
            red_flags: [
              { claim: "Free cash flow fell.", tag: "fact", evidence: "fcf 300000000000" },
            ],
          }),
        ),
      );

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);
      expect(outcome.result.executive_verdict.stance).toBe("mixed");
    });

    it("rejects a scenario naming a threshold outside the report's own set", async () => {
      // One threshold set per report, reused everywhere. We shipped 25% and
      // 30% for the same NVDA condition, and 10%/12%/13.9% for the same TCS
      // one, inside single reports.
      const payload = completion(
        fundamentalsPayload({
            scenarios: [
              { id: "bull", view: "Margins expand.", requires: "Operating margin holds up.", falsifier: "Margins compress." },
              { id: "base", view: "Margins hold.", requires: "Revenue growth persists.", falsifier: "Revenue growth stalls." },
              { id: "bear", view: "Margins compress.", requires: "Pricing weakens.", falsifier: "Operating margin holds above 37.4%." },
            ],
        }),
      );
      create.mockResolvedValue(payload);
      fallbackCreate.mockResolvedValue(payload);

      await expect(runFundamentalsAnalysis(FUNDAMENTALS_INPUT)).rejects.toMatchObject({
        code: "schema_validation",
      });
    });
  });


  describe("recovery from three failure modes observed on a fallback provider under load", () => {
    it("recovers when a verdict key (e.g. profitability.direction) is hoisted to the top level", async () => {
      // Reproduces a response observed in production on more than one
      // instrument: the model closed profitability's object right after
      // "evidence" and wrote "direction" as its own top-level key straight
      // after it, instead of nesting it inside profitability.
      const payload = fundamentalsPayload() as Record<string, unknown>;
      const profitability = payload["profitability"] as Record<string, unknown>;
      const { direction, ...profitabilityWithoutDirection } = profitability;
      const entries = Object.entries(payload).flatMap(([key, value]) =>
        key === "profitability"
          ? ([
              ["profitability", profitabilityWithoutDirection],
              ["direction", direction],
            ] as [string, unknown][])
          : ([[key, value]] as [string, unknown][]),
      );
      const content = JSON.stringify(Object.fromEntries(entries));
      create.mockResolvedValue({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 500 },
      });

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.profitability.direction).toBe("stable");
    });

    it("recovers when the model writes a literal, un-escaped newline inside a json string instead of \\n", async () => {
      // Observed in production: a weaker fallback model asked for "one json
      // object and nothing else" instead wrote its reasoning straight into
      // meta.confidence_reason, as a raw newline rather than an escaped one —
      // syntactically invalid JSON even though the content itself was fine.
      const payload = fundamentalsPayload();
      const leakedReason = `${payload.meta.confidence_reason}\nLet me reconsider: recheck check 3.`;
      const content = JSON.stringify(payload).replace(
        JSON.stringify(payload.meta.confidence_reason),
        JSON.stringify(leakedReason).replace(/\\n/g, "\n"),
      );
      create.mockResolvedValue({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 500 },
      });

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.meta.confidence_reason).toContain("Let me reconsider");
      expect(outcome.result.executive_verdict.stance).toBe("attractive");
    });

    it("repairs a red_flags item the model tagged 'unk' instead of failing the analysis outright", async () => {
      // Observed in production: a fallback model tagged one
      // executive_verdict.deciding_factors item "unk", which the schema
      // disallows there — the whole response failed validation and, being
      // the last provider in the chain, the analysis failed outright.
      create.mockResolvedValue(
        completion(
          fundamentalsPayload({
            red_flags: [
              { claim: "Return on equity is not reported.", tag: "unk", evidence: "profitability.returnOnEquity null" },
            ],
          }),
        ),
      );

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.red_flags[0]).toEqual({
        claim: "Return on equity is not reported.",
        tag: "inf",
        evidence: "profitability.returnOnEquity null",
      });
    });
  });
});

describe("AnalysisFailure", () => {
  it("carries a machine-readable code for the caller to branch on", () => {
    expect(new AnalysisFailure("api_error", "boom").code).toBe("api_error");
  });
});

describe("reclaimStrandedAnalyses", () => {
  /**
   * A minimal stand-in for the supabase-js query builder: every chain method
   * (select/update/insert/eq/lt/order/limit/returns) returns the same object,
   * and awaiting it resolves according to whichever of select/update/insert
   * was called most recently in the chain — enough to drive the two shapes
   * reclaimStrandedAnalyses actually builds, without a real client.
   */
  function chainable(selectResult: { data: unknown; error: unknown }) {
    let mode: "select" | "write" = "write";
    const builder = {
      select: () => {
        mode = "select";
        return builder;
      },
      update: () => builder,
      insert: () => builder,
      eq: () => builder,
      lt: () => builder,
      order: () => builder,
      limit: () => builder,
      returns: () => builder,
      then: (resolve: (v: unknown) => void) => {
        resolve(mode === "select" ? selectResult : { error: null });
      },
    };
    return builder;
  }

  it("refunds the fundamentals credit for a row stranded by a process restart", async () => {
    const row = {
      id: "a1",
      source: "fundamentals",
      profile_id: "p1",
      created_at: "2026-09-04T17:14:15.174246+00:00",
    };
    mockFrom.mockReturnValue(chainable({ data: [row], error: null }));

    const reclaimed = await reclaimStrandedAnalyses();

    expect(reclaimed).toBe(1);
    expect(mockCallRpc).toHaveBeenCalledWith("refund_credits", {
      p_profile_id: "p1",
      p_feature_key: "fundamental_analysis",
      p_ref_analysis_id: "a1",
    });
  });

  it("never touches the fundamentals refund for a non-fundamentals abandoned row", async () => {
    // "live" is neither "manual" (re-runnable) nor "fundamentals" — it lands
    // in the same abandoned/marked-failed bucket as fundamentals rows, and
    // this asserts the new refund call is gated on source, not on merely
    // being abandoned.
    const row = {
      id: "a2",
      source: "live",
      profile_id: "p1",
      created_at: "2026-09-04T17:14:15.174246+00:00",
    };
    mockFrom.mockReturnValue(chainable({ data: [row], error: null }));

    const reclaimed = await reclaimStrandedAnalyses();

    expect(reclaimed).toBe(1);
    expect(mockCallRpc).not.toHaveBeenCalled();
  });

  it("does nothing when no row is stranded", async () => {
    mockFrom.mockReturnValue(chainable({ data: [], error: null }));

    const reclaimed = await reclaimStrandedAnalyses();

    expect(reclaimed).toBe(0);
    expect(mockCallRpc).not.toHaveBeenCalled();
  });
});
