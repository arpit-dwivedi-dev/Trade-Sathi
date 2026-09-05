import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the seams this file owns: raw statements are fetched and derived
 * before the model call, the derived payload (never a provider-derived one)
 * is what reaches runFundamentalsAnalysis, the data notes written into the
 * stored result are ours rather than the model's, and a failure in the
 * retained verification layer can never fail the analysis run.
 *
 * The derivation itself is covered by the golden set in tests/golden/, and
 * the verification layer's own behaviour by
 * fundamentals-verification.service.test.ts.
 */

function chainable(result: Record<string, unknown>): PromiseLike<Record<string, unknown>> & Record<string, unknown> {
  const obj: Record<string, unknown> = {
    select: () => chainable(result),
    insert: () => chainable(result),
    update: () => chainable(result),
    eq: () => chainable(result),
    order: () => chainable(result),
    limit: () => chainable(result),
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (onFulfilled: (value: Record<string, unknown>) => unknown) =>
      Promise.resolve(result).then(onFulfilled),
  };
  return obj as PromiseLike<Record<string, unknown>> & Record<string, unknown>;
}

const from = vi.fn();
const callRpc = vi.fn();
vi.mock("../lib/supabase.js", () => ({ supabaseAdmin: { from }, callRpc }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../lib/error-log.js", () => ({ logAppError: vi.fn() }));

// The audit layer is off by default in production; these tests keep it ON so
// the pipeline's guard around it is actually exercised rather than skipped.
vi.mock("../lib/env.js", () => ({ env: { fundamentalsVerificationEnabled: true } }));

const fetchInstrumentById = vi.fn();
const getFundamentalsForInstrument = vi.fn();
const getRawStatementsForInstrument = vi.fn();
vi.mock("./market-chart.service.js", () => ({
  fetchInstrumentById,
  getFundamentalsForInstrument,
  getRawStatementsForInstrument,
}));

const deriveFundamentals = vi.fn();
vi.mock("./fundamentals/index.js", () => ({ deriveFundamentals }));

const runFundamentalsAnalysis = vi.fn();
vi.mock("./ai-analysis.service.js", () => ({
  AnalysisFailure: class AnalysisFailure extends Error {
    code = "api_error";
  },
  FUNDAMENTALS_PROMPT_VERSION: "fundamentals-v1",
  runFundamentalsAnalysis,
}));

const verifyFundamentalsPayload = vi.fn();
vi.mock("./fundamentals-verification.service.js", () => ({ verifyFundamentalsPayload }));

const { triggerFundamentalsAnalysis } = await import("./fundamentals-analysis.service.js");

const REF = {
  instrumentId: "i1",
  instrumentKey: "RELIANCE.NS",
  exchange: "NSE",
  symbol: "RELIANCE",
  name: "Reliance Industries",
};

const RAW_PROVIDER_FUNDAMENTALS = { meta: { currency: "INR" } } as Record<string, unknown>;
const RAW_STATEMENTS = { quarterly: [], annual: [], spot: {}, forward: [], corporateActions: null };

const DATA_NOTES = [
  { title: "The share price is out of date", detail: "...", severity: "caution" as const },
];
const DERIVED = {
  profile: { exchange: "NSE" },
  metrics: { revenue: { value: 1, period: "TTM x..y", reliability: "ok" } },
  facts: { leverageBand: "low" },
  dataNotes: DATA_NOTES,
  findings: [{ metric: "price", rule: "price_stale", detail: "..." }],
  quartersUsed: ["2026-03-31", "2026-06-30"],
} as unknown as Record<string, unknown>;

beforeEach(() => {
  from.mockReset();
  callRpc.mockReset();
  fetchInstrumentById.mockReset();
  getFundamentalsForInstrument.mockReset();
  getRawStatementsForInstrument.mockReset();
  deriveFundamentals.mockReset();
  runFundamentalsAnalysis.mockReset();
  verifyFundamentalsPayload.mockReset();

  fetchInstrumentById.mockResolvedValue(REF);
  getFundamentalsForInstrument.mockResolvedValue(RAW_PROVIDER_FUNDAMENTALS);
  getRawStatementsForInstrument.mockResolvedValue(RAW_STATEMENTS);
  deriveFundamentals.mockReturnValue(DERIVED);
  callRpc.mockResolvedValue(true);

  from
    .mockImplementationOnce(() => chainable({ data: null, error: null })) // in-flight lookup
    .mockImplementationOnce(() => chainable({ data: { id: "analysis-1" }, error: null })) // queued insert
    .mockImplementationOnce(() => chainable({ error: null })); // terminal update
});

describe("triggerFundamentalsAnalysis", () => {
  it("hands the DERIVED payload to runFundamentalsAnalysis, never a provider one", async () => {
    verifyFundamentalsPayload.mockResolvedValue({ payload: {}, audit: { fields: [] } });
    runFundamentalsAnalysis.mockResolvedValue({
      result: { executive_verdict: { stance: "mixed" }, summary: "" },
      modelId: "m",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      latencyMs: 1,
    });

    await triggerFundamentalsAnalysis("profile-1", "instrument-1");
    await vi.waitFor(() => expect(runFundamentalsAnalysis).toHaveBeenCalled());

    expect(getRawStatementsForInstrument).toHaveBeenCalledWith(REF);
    expect(deriveFundamentals).toHaveBeenCalledWith(RAW_STATEMENTS, "NSE");

    const [input] = runFundamentalsAnalysis.mock.calls[0] as [Record<string, unknown>];
    expect(input.derived).toBe(DERIVED);
    expect(input.instrument).toMatchObject({ id: "i1", symbol: "RELIANCE" });
  });

  it("writes its own data notes and debug trace into the stored result", async () => {
    // The notes are deterministic output of the plausibility gate. Letting
    // the model restate them would let it soften or drop one.
    verifyFundamentalsPayload.mockResolvedValue({ payload: {}, audit: { fields: [] } });
    runFundamentalsAnalysis.mockResolvedValue({
      result: { executive_verdict: { stance: "mixed" }, summary: "s" },
      modelId: "m",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      latencyMs: 1,
    });

    const updates: Record<string, unknown>[] = [];
    from.mockReset();
    from
      .mockImplementationOnce(() => chainable({ data: null, error: null }))
      .mockImplementationOnce(() => chainable({ data: { id: "analysis-1" }, error: null }))
      .mockImplementation(() => {
        const result: Record<string, unknown> = { error: null };
        const obj: Record<string, unknown> = {
          update: (payload: Record<string, unknown>) => {
            updates.push(payload);
            return chainable(result);
          },
          select: () => chainable(result),
          eq: () => chainable(result),
        };
        return obj;
      });

    await triggerFundamentalsAnalysis("profile-1", "instrument-1");
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

    const stored = updates[0]["fundamentals_result"] as Record<string, unknown>;
    expect(stored["data_notes"]).toEqual(DATA_NOTES);
    expect(stored["debug"]).toMatchObject({ quartersUsed: ["2026-03-31", "2026-06-30"] });
  });

  it("still completes when the retained verification layer throws", async () => {
    // verifyFundamentalsPayload's own contract is that it never throws. This
    // exercises the pipeline's independent try/catch around it, so a defect
    // on the other side of that boundary still cannot turn into a failed,
    // entitlement-wasting run — and, now that the layer is audit-only, its
    // failure costs nothing but the audit.
    verifyFundamentalsPayload.mockRejectedValue(new Error("verification exploded"));
    runFundamentalsAnalysis.mockResolvedValue({
      result: { executive_verdict: { stance: "mixed" }, summary: "" },
      modelId: "m",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      latencyMs: 1,
    });

    const result = await triggerFundamentalsAnalysis("profile-1", "instrument-1");
    expect(result.ok).toBe(true);

    await vi.waitFor(() => expect(runFundamentalsAnalysis).toHaveBeenCalled());
    const [input] = runFundamentalsAnalysis.mock.calls[0] as [Record<string, unknown>];
    expect(input.derived).toBe(DERIVED);
  });
});
