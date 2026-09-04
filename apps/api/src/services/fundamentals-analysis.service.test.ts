import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers only the seam this file adds: the verification layer sits between
 * the raw provider fetch and the existing, unmodified runFundamentalsAnalysis
 * call, and a verifier failure must never fail the analysis run. The
 * verification logic itself (enrichment, staleness, conflicts, and so on) is
 * covered in fundamentals-verification.service.test.ts.
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

const fetchInstrumentById = vi.fn();
const getFundamentalsForInstrument = vi.fn();
vi.mock("./market-chart.service.js", () => ({ fetchInstrumentById, getFundamentalsForInstrument }));

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
const VERIFIED_PAYLOAD = { meta: { currency: "INR" }, verified: true } as Record<string, unknown>;

beforeEach(() => {
  from.mockReset();
  callRpc.mockReset();
  fetchInstrumentById.mockReset();
  getFundamentalsForInstrument.mockReset();
  runFundamentalsAnalysis.mockReset();
  verifyFundamentalsPayload.mockReset();

  fetchInstrumentById.mockResolvedValue(REF);
  getFundamentalsForInstrument.mockResolvedValue(RAW_PROVIDER_FUNDAMENTALS);
  callRpc.mockResolvedValue(true);

  from
    .mockImplementationOnce(() => chainable({ data: null, error: null })) // in-flight lookup
    .mockImplementationOnce(() => chainable({ data: { id: "analysis-1" }, error: null })) // queued insert
    .mockImplementationOnce(() => chainable({ error: null })); // terminal update
});

describe("triggerFundamentalsAnalysis", () => {
  it("hands the verified payload, not the raw one, to runFundamentalsAnalysis", async () => {
    verifyFundamentalsPayload.mockResolvedValue({ payload: VERIFIED_PAYLOAD, audit: { fields: [] } });
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

    const [verifyCallPayload, verifyCallRef, verifyCallProfileId] = verifyFundamentalsPayload.mock
      .calls[0] as unknown[];
    expect(verifyCallPayload).toMatchObject({ instrument: { id: "i1" } });
    expect(verifyCallRef).toEqual(REF);
    expect(verifyCallProfileId).toBe("profile-1");
    expect(runFundamentalsAnalysis).toHaveBeenCalledWith(VERIFIED_PAYLOAD);
  });

  it("falls back to the raw payload and still completes when verification throws", async () => {
    // verifyFundamentalsPayload's own contract is that it never throws (see
    // fundamentals-verification.service.test.ts) — this exercises the
    // pipeline's independent try/catch around that call, so a defect on the
    // other side of that boundary still can't turn into a failed,
    // entitlement-wasting analysis run.
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
    // Falls back to the raw provider payload, not the (never-resolved)
    // verified one.
    const [calledPayload] = runFundamentalsAnalysis.mock.calls[0] as unknown[];
    expect(calledPayload).toMatchObject({ instrument: { id: "i1" } });
    expect(calledPayload).not.toBe(VERIFIED_PAYLOAD);
  });
});
