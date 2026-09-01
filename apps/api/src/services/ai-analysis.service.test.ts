import { beforeEach, describe, expect, it, vi } from "vitest";

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

/** A schema-valid model response, with `call.direction` swapped per test. */
function completion(direction: string, promptTokens = 1_000, completionTokens = 500) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            symbol: "RELIANCE",
            asset_class: "stock",
            timeframe: "d1",
            trend: "neutral",
            volatility: "low",
            volume: "low",
            sentiment: "neutral",
            support_levels: [0.5],
            resistance_levels: [2],
            patterns: [],
            call: {
              direction,
              confidence: 0.24,
              entry: null,
              invalidation: null,
              target: null,
              horizon_candles: 8,
            },
            summary: "No readable structure.",
          }),
        },
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

beforeEach(() => {
  create.mockReset();
  fallbackCreate.mockReset();
});

describe("call.direction validation", () => {
  // The prompts instruct the model to abstain with "none"; the stored enum
  // spells that state "hold". Before these were reconciled, every abstention
  // failed validation and the whole analysis failed.
  it("normalises the prompt's 'none' abstention to the stored 'hold'", async () => {
    create.mockResolvedValue(completion("none"));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.call.direction).toBe("hold");
    // One attempt only: a valid response must never be retried.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["long", "short", "hold"])("passes %s through unchanged", async (direction) => {
    create.mockResolvedValue(completion(direction));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.call.direction).toBe(direction);
  });

  it("still rejects a direction outside the contract", async () => {
    // Both providers: an out-of-contract direction is the model breaking the
    // contract, not a provider outage, so the chain runs out and the schema
    // failure is what surfaces.
    create.mockResolvedValue(completion("buy"));
    fallbackCreate.mockResolvedValue(completion("buy"));

    await expect(runSeriesAnalysis(CANDLES, CONTEXT)).rejects.toMatchObject({
      code: "schema_validation",
    });
  });

  it("reports the token usage the provider returned", async () => {
    create.mockResolvedValue(completion("long"));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.inputTokens).toBe(1_000);
    expect(outcome.outputTokens).toBe(500);
  });
});

describe("cost estimation", () => {
  it("prices tokens at the rates of the provider that served the call", async () => {
    // 1M input at $2 + 0.5M output at $10, the primary's configured rates.
    create.mockResolvedValue(completion("long", 1_000_000, 500_000));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.costUsd).toBeCloseTo(7, 10);
    expect(outcome.modelId).toBe("test-model");
  });

  it("prices a failed-over call at the FALLBACK's rates, not the primary's", async () => {
    create.mockRejectedValue(new Error("upstream down"));
    fallbackCreate.mockResolvedValue(completion("long", 1_000_000, 500_000));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    // 1M at $1 + 0.5M at $4 — charging the primary's rates here would
    // silently misreport margin on every failed-over run.
    expect(outcome.costUsd).toBeCloseTo(3, 10);
    expect(outcome.modelId).toBe("fallback-model");
  });

  it("is zero when the provider reported no usage", async () => {
    create.mockResolvedValue(completion("long", 0, 0));

    expect((await runSeriesAnalysis(CANDLES, CONTEXT)).costUsd).toBe(0);
  });
});

describe("provider fallback", () => {
  it("falls back to the next provider when the primary keeps failing", async () => {
    create.mockRejectedValue(new Error("upstream down"));
    fallbackCreate.mockResolvedValue(completion("long"));

    const outcome = await runSeriesAnalysis(CANDLES, CONTEXT);

    expect(outcome.result.call.direction).toBe("long");
    // The primary gets its own two attempts before the chain moves on.
    expect(create).toHaveBeenCalledTimes(2);
    expect(fallbackCreate).toHaveBeenCalledTimes(1);
  });

  it("never touches the fallback when the primary succeeds", async () => {
    create.mockResolvedValue(completion("long"));

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
