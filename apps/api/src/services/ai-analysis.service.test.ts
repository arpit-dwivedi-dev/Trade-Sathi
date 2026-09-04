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
vi.mock("../lib/supabase.js", () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { AnalysisFailure, runSeriesAnalysis, runVisualAnalysis } = await import(
  "./ai-analysis.service.js"
);

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

function completion(payload: unknown, promptTokens = 1_000, completionTokens = 500) {
  return {
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

beforeEach(() => {
  create.mockReset();
  fallbackCreate.mockReset();
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

describe("AnalysisFailure", () => {
  it("carries a machine-readable code for the caller to branch on", () => {
    expect(new AnalysisFailure("api_error", "boom").code).toBe("api_error");
  });
});
