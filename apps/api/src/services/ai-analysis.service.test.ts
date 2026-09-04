import { beforeEach, describe, expect, it, vi } from "vitest";
import { callDirectionFor } from "@chartanalyzer/shared";

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

/** A minimal InstrumentFundamentals payload — runFundamentalsAnalysis only
 *  serializes it into the prompt, so its exact figures don't matter here. */
const FUNDAMENTALS_INPUT = {
  instrument: { id: "i1", symbol: "RELIANCE", name: "Reliance Industries", exchange: "NSE" },
  meta: { currency: "INR", financialCurrency: "INR", asOf: "2026-08-31", mostRecentQuarter: "2026-06-30" },
  profile: { sector: "Energy", industry: "Refining", employees: 100000, website: null, summary: "A conglomerate." },
  snapshot: {
    price: 1400, change: 5, changePercent: 0.0036, previousClose: 1395, dayLow: 1390, dayHigh: 1410,
    fiftyTwoWeekLow: 1200, fiftyTwoWeekHigh: 1550, fiftyDayAverage: 1380, twoHundredDayAverage: 1350,
    volume: 5_000_000, averageVolume: 4_000_000, marketCap: 18_000_000_000_000,
  },
  valuation: {
    trailingPe: 24, forwardPe: 20, pegRatio: null, priceToBook: 2.1, priceToSales: 1.8,
    enterpriseValue: 19_000_000_000_000, enterpriseToRevenue: 2, enterpriseToEbitda: 12,
    trailingEps: 58.3, forwardEps: 70, bookValue: 666, dividendYield: 0.004, dividendRate: 5.5,
    payoutRatio: 0.09, beta: 1.1,
  },
  profitability: {
    grossMargin: 0.3, operatingMargin: 0.12, ebitdaMargin: 0.15, profitMargin: 0.08,
    returnOnEquity: 0.09, returnOnAssets: 0.05,
  },
  growth: { revenueGrowth: 0.1, earningsGrowth: 0.07, earningsQuarterlyGrowth: 0.05 },
  health: {
    totalRevenue: 9_000_000_000_000, ebitda: 1_350_000_000_000, netIncome: 720_000_000_000,
    totalCash: 200_000_000_000, totalDebt: 1_200_000_000_000, debtToEquity: 41.2, currentRatio: 1.1,
    quickRatio: 0.8, freeCashflow: 300_000_000_000, operatingCashflow: 900_000_000_000,
    sharesOutstanding: 6_766_000_000,
  },
  annual: [
    { asOfDate: "2024-03-31", revenue: 8_000_000_000_000, operatingIncome: 900_000_000_000, netIncome: 650_000_000_000, dilutedEps: 48, operatingCashflow: 800_000_000_000, freeCashflow: 250_000_000_000 },
    { asOfDate: "2025-03-31", revenue: 8_500_000_000_000, operatingIncome: 950_000_000_000, netIncome: 690_000_000_000, dilutedEps: 51, operatingCashflow: 850_000_000_000, freeCashflow: 280_000_000_000 },
    { asOfDate: "2026-03-31", revenue: 9_000_000_000_000, operatingIncome: 1_000_000_000_000, netIncome: 720_000_000_000, dilutedEps: 58.3, operatingCashflow: 900_000_000_000, freeCashflow: 300_000_000_000 },
  ],
};

/** A schema-valid response, per prompts/fundamentals-analysis.ts's json shape. */
function fundamentalsPayload(overrides: Record<string, unknown> = {}) {
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
      commitment: "Margins are stable and leverage is moderate against steady revenue growth.",
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
      { id: "bull", view: "Margins expand as refining spreads improve.", requires: "Operating margin above 13%.", falsifier: "Margin falls below 10%." },
      { id: "base", view: "Margins hold near current levels.", requires: "Revenue growth continues near 10%.", falsifier: "Revenue growth turns negative." },
      { id: "bear", view: "Margins compress on rising input costs.", requires: "Operating margin below 9%.", falsifier: "Margin recovers above 11%." },
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

  it("throws the LAST provider's failure once the chain is exhausted", async () => {
    create.mockRejectedValue(new Error("upstream down"));
    fallbackCreate.mockResolvedValue({ choices: [{ message: { content: "" } }] });

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "invalid_json",
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

  describe("leverage band reconciliation", () => {
    it("corrects a leverage band that contradicts the payload's own debtToEquity", async () => {
      // FUNDAMENTALS_INPUT.health.debtToEquity is 41.2 (bands to "low") and
      // totalDebt is a real, positive figure — "zero" is the exact
      // mislabeling observed in production (positive gross debt called "zero"
      // leverage), which this guard exists to correct without a retry.
      create.mockResolvedValue(completion(fundamentalsPayload({ balance_sheet: { statement: "x", tag: "fact", evidence: "e", leverage: "zero" } })));

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.balance_sheet.leverage).toBe("low");
      expect(outcome.result.meta.data_issues.some((line) => line.includes('"zero"') && line.includes('"low"'))).toBe(
        true,
      );
      // Corrected via post-processing, not a retry.
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("leaves an already-correct leverage band untouched, with no spurious note", async () => {
      create.mockResolvedValue(completion(fundamentalsPayload())); // leverage: "low", matching debtToEquity 41.2

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.balance_sheet.leverage).toBe("low");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
    });

    it("never overrides 'unk' — a deliberate sector-structural call, not a miscalculation", async () => {
      create.mockResolvedValue(
        completion(fundamentalsPayload({ balance_sheet: { statement: "x", tag: "unk", evidence: "e", leverage: "unk" } })),
      );

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.balance_sheet.leverage).toBe("unk");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
    });

    it("leaves the band alone when debtToEquity is unreported — banding is then a judgment call", async () => {
      const noDebtToEquity = { ...FUNDAMENTALS_INPUT, health: { ...FUNDAMENTALS_INPUT.health, debtToEquity: null } };
      create.mockResolvedValue(
        completion(fundamentalsPayload({ balance_sheet: { statement: "x", tag: "calc", evidence: "e", leverage: "zero" } })),
      );

      const outcome = await runFundamentalsAnalysis(noDebtToEquity);

      expect(outcome.result.balance_sheet.leverage).toBe("zero");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
    });
  });

  describe("growth_supports_earnings reconciliation", () => {
    it("corrects 'yes' to 'no' when earningsGrowth is negative while revenueGrowth is positive", async () => {
      const negativeEarnings = {
        ...FUNDAMENTALS_INPUT,
        growth: { ...FUNDAMENTALS_INPUT.growth, revenueGrowth: 0.1, earningsGrowth: -0.02 },
      };
      create.mockResolvedValue(completion(fundamentalsPayload())); // growth_supports_earnings: "yes"

      const outcome = await runFundamentalsAnalysis(negativeEarnings);

      expect(outcome.result.performance.growth_supports_earnings).toBe("no");
      expect(
        outcome.result.meta.data_issues.some((line) => line.includes("growth_supports_earnings")),
      ).toBe(true);
    });

    it("corrects 'yes' to 'no' when earningsGrowth trails revenueGrowth by more than 5 points", async () => {
      const laggingEarnings = {
        ...FUNDAMENTALS_INPUT,
        growth: { ...FUNDAMENTALS_INPUT.growth, revenueGrowth: 0.139, earningsGrowth: 0.046 },
      };
      create.mockResolvedValue(completion(fundamentalsPayload({ performance: {
        revenue_trend: { statement: "x", tag: "fact", evidence: "e" },
        earnings_trend: { statement: "x", tag: "fact", evidence: "e" },
        growth_supports_earnings: "mixed",
      } })));

      const outcome = await runFundamentalsAnalysis(laggingEarnings);

      expect(outcome.result.performance.growth_supports_earnings).toBe("no");
    });

    it("leaves 'yes' untouched when earnings growth genuinely keeps pace", async () => {
      create.mockResolvedValue(completion(fundamentalsPayload())); // FUNDAMENTALS_INPUT: revenueGrowth 0.1, earningsGrowth 0.07

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.performance.growth_supports_earnings).toBe("yes");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
    });

    it("never overrides 'unk'", async () => {
      const negativeEarnings = {
        ...FUNDAMENTALS_INPUT,
        growth: { ...FUNDAMENTALS_INPUT.growth, revenueGrowth: 0.1, earningsGrowth: -0.02 },
      };
      create.mockResolvedValue(completion(fundamentalsPayload({ performance: {
        revenue_trend: { statement: "x", tag: "fact", evidence: "e" },
        earnings_trend: { statement: "x", tag: "unk", evidence: "e" },
        growth_supports_earnings: "unk",
      } })));

      const outcome = await runFundamentalsAnalysis(negativeEarnings);

      expect(outcome.result.performance.growth_supports_earnings).toBe("unk");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
    });
  });

  describe("dividend sustainability reconciliation", () => {
    it("corrects an unexplained payout discrepancy to 'unk'", async () => {
      // dividendRate 20 / trailingEps 58.3 = 0.343, badly disagreeing with the
      // supplied payoutRatio of 0.09 — no attribution keyword in the statement.
      const discordantPayout = {
        ...FUNDAMENTALS_INPUT,
        valuation: { ...FUNDAMENTALS_INPUT.valuation, dividendRate: 20 },
      };
      create.mockResolvedValue(completion(fundamentalsPayload())); // sustainability: "conservative"

      const outcome = await runFundamentalsAnalysis(discordantPayout);

      expect(outcome.result.dividend.sustainability).toBe("unk");
      expect(
        outcome.result.meta.data_issues.some((line) => line.includes("dividend.sustainability")),
      ).toBe(true);
    });

    it("leaves the call alone when the statement attributes the discrepancy", async () => {
      const discordantPayout = {
        ...FUNDAMENTALS_INPUT,
        valuation: { ...FUNDAMENTALS_INPUT.valuation, dividendRate: 20 },
      };
      create.mockResolvedValue(
        completion(
          fundamentalsPayload({
            dividend: {
              statement: "The gap is consistent with a special dividend included in dividendRate.",
              tag: "calc",
              evidence: "valuation.payoutRatio 0.09 vs dividendRate/trailingEps 0.343",
              sustainability: "conservative",
            },
          }),
        ),
      );

      const outcome = await runFundamentalsAnalysis(discordantPayout);

      expect(outcome.result.dividend.sustainability).toBe("conservative");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
    });

    it("leaves an already-'unk' call untouched", async () => {
      const discordantPayout = {
        ...FUNDAMENTALS_INPUT,
        valuation: { ...FUNDAMENTALS_INPUT.valuation, dividendRate: 20 },
      };
      create.mockResolvedValue(
        completion(
          fundamentalsPayload({
            dividend: { statement: "x", tag: "unk", evidence: "e", sustainability: "unk" },
          }),
        ),
      );

      const outcome = await runFundamentalsAnalysis(discordantPayout);

      expect(outcome.result.dividend.sustainability).toBe("unk");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
    });

    it("leaves a reconciled payout ratio untouched — FUNDAMENTALS_INPUT's own figures", async () => {
      // 5.5 / 58.3 = 0.0943, an absolute difference of 0.0043 from the
      // supplied 0.09 — below the 0.005 floor TOLERANCE treats as noise.
      create.mockResolvedValue(completion(fundamentalsPayload()));

      const outcome = await runFundamentalsAnalysis(FUNDAMENTALS_INPUT);

      expect(outcome.result.dividend.sustainability).toBe("conservative");
      expect(outcome.result.meta.data_issues).toHaveLength(0);
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

  it("refunds the fundamentals entitlement for a row stranded by a process restart", async () => {
    const row = {
      id: "a1",
      source: "fundamentals",
      profile_id: "p1",
      created_at: "2026-09-04T17:14:15.174246+00:00",
    };
    mockFrom.mockReturnValue(chainable({ data: [row], error: null }));

    const reclaimed = await reclaimStrandedAnalyses();

    expect(reclaimed).toBe(1);
    expect(mockCallRpc).toHaveBeenCalledWith("decrement_fundamentals_usage", {
      p_profile_id: "p1",
      p_period: "2026-09",
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
