import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentFundamentals } from "@chartanalyzer/shared";

const search = vi.fn();
const isConfigured = vi.fn(() => true);

vi.mock("../lib/search/searxng-search-provider.js", () => ({
  SearxngSearchProvider: class {
    isConfigured = isConfigured;
    search = search;
  },
}));

const logAppError = vi.fn();
vi.mock("../lib/error-log.js", () => ({ logAppError }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const envState = { fundamentalsVerificationEnabled: true, searxngBaseUrl: "https://searx.local" };
vi.mock("../lib/env.js", () => ({ env: envState }));

const { verifyFundamentalsPayload, clearFundamentalsVerificationCache } = await import(
  "./fundamentals-verification.service.js"
);

const REF = {
  instrumentId: "i1",
  instrumentKey: "RELIANCE.NS",
  exchange: "NSE",
  symbol: "RELIANCE",
  name: "Reliance Industries",
};

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * A fully self-consistent payload: every cross-check reconciles, every date
 * is fresh, so every field starts "unchecked" unless a test overrides it.
 * marketCap = price * sharesOutstanding, trailingPe = price / trailingEps,
 * payoutRatio = dividendRate / trailingEps, dividendYield = dividendRate / price.
 */
function basePayload(overrides: Partial<InstrumentFundamentals> = {}): InstrumentFundamentals {
  return {
    instrument: { id: "i1", symbol: "RELIANCE", name: "Reliance Industries", exchange: "NSE" },
    meta: {
      currency: "INR",
      financialCurrency: "INR",
      asOf: daysAgo(0),
      mostRecentQuarter: daysAgo(30),
    },
    profile: { sector: null, industry: null, employees: null, website: null, summary: null },
    snapshot: {
      price: 100,
      change: null,
      changePercent: null,
      previousClose: null,
      dayLow: null,
      dayHigh: null,
      fiftyTwoWeekLow: 80,
      fiftyTwoWeekHigh: 120,
      fiftyDayAverage: null,
      twoHundredDayAverage: null,
      volume: null,
      averageVolume: null,
      marketCap: 1000,
    },
    valuation: {
      trailingPe: 10,
      forwardPe: null,
      pegRatio: null,
      payoutRatio: 0.2,
      priceToBook: null,
      priceToSales: null,
      enterpriseValue: null,
      enterpriseToRevenue: null,
      enterpriseToEbitda: null,
      trailingEps: 10,
      forwardEps: null,
      bookValue: null,
      dividendYield: 0.02,
      dividendRate: 2,
      beta: null,
    },
    profitability: {
      grossMargin: null,
      operatingMargin: null,
      ebitdaMargin: null,
      profitMargin: null,
      returnOnEquity: null,
      returnOnAssets: null,
    },
    growth: { revenueGrowth: null, earningsGrowth: null, earningsQuarterlyGrowth: null },
    health: {
      totalRevenue: null,
      ebitda: null,
      netIncome: null,
      totalCash: 500,
      totalDebt: 200,
      debtToEquity: 30,
      currentRatio: null,
      quickRatio: null,
      freeCashflow: 100,
      operatingCashflow: 150,
      sharesOutstanding: 10,
    },
    annual: [{ asOfDate: daysAgo(90), revenue: 900, operatingIncome: null, netIncome: 100, dilutedEps: null, operatingCashflow: null, freeCashflow: null }],
    ...overrides,
  };
}

function tier1Result(snippet: string, url = "https://www.nseindia.com/x") {
  return {
    source: { tier: "tier1" as const, name: "NSE India", url },
    title: "",
    snippet,
  };
}

function tier2Result(snippet: string, url = "https://www.screener.in/x") {
  return {
    source: { tier: "tier2" as const, name: "Screener.in", url },
    title: "",
    snippet,
  };
}

beforeEach(() => {
  clearFundamentalsVerificationCache();
  search.mockReset();
  isConfigured.mockReset();
  isConfigured.mockReturnValue(true);
  logAppError.mockReset();
  envState.fundamentalsVerificationEnabled = true;
  envState.searxngBaseUrl = "https://searx.local";
});

describe("verifyFundamentalsPayload", () => {
  it("records a clean authoritative hit for a missing field without applying it", async () => {
    const payload = basePayload({
      health: { ...basePayload().health, sharesOutstanding: null },
    });
    search.mockResolvedValue([
      tier1Result("Reliance Industries shares outstanding: 6,765,000,000."),
    ]);

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    // The evidence is kept in the audit; the field stays unreported. This
    // layer used to enrich a null here, and enrichment is a write.
    const field = audit?.fields.find((f) => f.field === "health.sharesOutstanding");
    expect(field?.status).toBe("conflict");
    expect(field?.originalValue).toBeNull();
    expect(field?.verifiedValue).toBe(6765000000);
    expect(field?.evidence).toHaveLength(1);
    expect(result.health.sharesOutstanding).toBeNull();
    expect(payload.health.sharesOutstanding).toBeNull();
  });

  it("flags stale data without inventing a correction when no evidence is found", async () => {
    const payload = basePayload({
      meta: { ...basePayload().meta, mostRecentQuarter: daysAgo(220) },
    });
    search.mockResolvedValue([]);

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    const field = audit?.fields.find((f) => f.field === "health.totalDebt");
    expect(field?.deterministicFlags).toContain("stale");
    expect(field?.status).toBe("unverifiable");
    expect(field?.verifiedValue).toBeNull();
    expect(result.health.totalDebt).toBe(200); // untouched
  });

  it("rejects evidence for a different fiscal period rather than correcting on it", async () => {
    const payload = basePayload({
      annual: [
        { asOfDate: daysAgo(90), revenue: 900, operatingIncome: null, netIncome: null, dilutedEps: null, operatingCashflow: null, freeCashflow: null },
      ],
    });
    const expectedYear = new Date(payload.meta.asOf as string).getUTCFullYear();
    const wrongYear = expectedYear - 3; // well outside any reasonable fiscal reading
    search.mockResolvedValue([tier1Result(`Net income FY${wrongYear}: ₹65,000 crore`)]);

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    const field = audit?.fields.find((f) => f.field === "annual.latest.netIncome");
    expect(field?.status).toBe("unverifiable");
    expect(field?.verifiedValue).toBeNull();
    expect(result.annual[0].netIncome).toBeNull();
  });

  it("flags a currency/unit mismatch and never attempts a cross-currency correction", async () => {
    const base = basePayload();
    const payload = basePayload({
      meta: { ...base.meta, currency: "INR", financialCurrency: "USD" },
      // forwardPe is null in the base fixture (would raise its own
      // unrelated "missing" flag and trigger a group lookup); give it a
      // value here so every currency-gated field in this test is flagged
      // solely for the mismatch under test.
      valuation: { ...base.valuation, forwardPe: 11 },
    });

    const { audit } = await verifyFundamentalsPayload(payload, REF);

    const field = audit?.fields.find((f) => f.field === "valuation.trailingPe");
    expect(field?.deterministicFlags).toContain("unit_mismatch");
    expect(field?.status).toBe("unverifiable");
    expect(search).not.toHaveBeenCalled();
  });

  it("marks a field 'conflict' and keeps the original value when sources disagree", async () => {
    const payload = basePayload({
      health: { ...basePayload().health, sharesOutstanding: null },
    });
    search.mockResolvedValue([
      tier1Result("Reliance Industries shares outstanding: 6,765,000,000."),
      tier2Result("Reliance Industries shares outstanding: 5,000,000,000."),
    ]);

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    const field = audit?.fields.find((f) => f.field === "health.sharesOutstanding");
    expect(field?.status).toBe("conflict");
    expect(field?.verifiedValue).toBeNull();
    expect(audit?.materialConflict).toBe(true);
    expect(result.health.sharesOutstanding).toBeNull();
  });

  it("records a disagreement on a present value without overwriting it", async () => {
    // sharesOutstanding is present (10) but stale — MRQ is 220 days behind
    // asOf — which is what earns it an external lookup at all; a single
    // clean tier1 source then reports a materially different value (20),
    // well past the 5% tolerance. That used to be applied as a correction.
    const payload = basePayload({
      meta: { ...basePayload().meta, mostRecentQuarter: daysAgo(220) },
      health: { ...basePayload().health, sharesOutstanding: 10 },
    });
    search.mockResolvedValue([tier1Result("Reliance Industries shares outstanding: 20.")]);

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    const field = audit?.fields.find((f) => f.field === "health.sharesOutstanding");
    expect(field?.status).toBe("conflict");
    expect(field?.originalValue).toBe(10);
    expect(field?.verifiedValue).toBe(20);
    expect(result.health.sharesOutstanding).toBe(10);
  });

  it("no longer audits the provider's payout-ratio field at all", async () => {
    // The provider-computed payout ratio used to be a checked field, and
    // dividendRate was cross-checked against it. Both are gone: the report
    // derives its two payout bases from raw statements, so auditing the
    // provider's version corroborates a number nothing reads.
    const { audit } = await verifyFundamentalsPayload(basePayload(), REF);
    const paths = (audit?.fields ?? []).map((f) => f.field);
    expect(paths).not.toContain("valuation.payoutRatio");
    expect(paths).not.toContain("health.freeCashflow");
    // Reported per-share figures are still audited on their own terms.
    expect(paths).toContain("valuation.dividendRate");
  });

  it("keeps a field unverifiable when no usable evidence exists", async () => {
    const payload = basePayload({
      health: { ...basePayload().health, sharesOutstanding: null },
    });
    search.mockResolvedValue([]); // no hits at all

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    const field = audit?.fields.find((f) => f.field === "health.sharesOutstanding");
    expect(field?.status).toBe("unverifiable");
    expect(result.health.sharesOutstanding).toBeNull();
  });

  it("never blocks the pipeline when the search provider throws", async () => {
    const payload = basePayload({
      health: { ...basePayload().health, sharesOutstanding: null },
    });
    search.mockRejectedValue(new Error("searxng is down"));

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    expect(result).toBe(payload); // handed back untouched
    expect(audit?.fields.find((f) => f.field === "health.sharesOutstanding")?.status).toBe(
      "unverifiable",
    );
  });

  it("never throws even when the engine itself blows up, and returns the original payload", async () => {
    const payload = basePayload();
    isConfigured.mockImplementation(() => {
      throw new Error("boom");
    });

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    expect(result).toBe(payload);
    expect(audit).toBeNull();
    expect(logAppError).toHaveBeenCalled();
  });

  it("passes the payload through unchanged when verification is disabled", async () => {
    envState.fundamentalsVerificationEnabled = false;
    const payload = basePayload({
      health: { ...basePayload().health, sharesOutstanding: null },
    });

    const { payload: result, audit } = await verifyFundamentalsPayload(payload, REF);

    expect(result).toBe(payload);
    expect(audit).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });
});

/**
 * THE LOCK.
 *
 * This layer is retained for reuse by the news-analysis feature, but it must
 * never again be able to change a fundamentals number. Reference equality is
 * the assertion on purpose: a deep-equality check would still pass if the
 * function cloned the payload and wrote a "correction" that happened to match,
 * and it is precisely the clone-and-write path that let snippet corroboration
 * stamp quarterly-basis values as verified.
 *
 * If this test ever fails, the write path has come back. Do not relax it.
 */
describe("the fundamentals path is structurally non-mutating", () => {
  beforeEach(() => {
    envState.fundamentalsVerificationEnabled = true;
    clearFundamentalsVerificationCache();
    search.mockReset();
    isConfigured.mockReturnValue(true);
  });

  it("fundamentals path never mutates the payload", async () => {
    const input = basePayload();
    const { payload } = await verifyFundamentalsPayload(input, REF);
    expect(payload).toBe(input);
  });

  it("returns the same object even when evidence disagrees with a field", async () => {
    // A stale field, plus an unambiguous tier1 source stating a different
    // value — the exact shape that used to produce a "corrected" write.
    const input = basePayload({
      meta: {
        currency: "INR",
        financialCurrency: "INR",
        asOf: daysAgo(0),
        mostRecentQuarter: daysAgo(400),
      },
    });
    const before = JSON.stringify(input);
    search.mockResolvedValue([
      {
        source: { tier: "tier1", name: "NSE India", url: "https://nseindia.com/x" },
        title: "Total debt",
        snippet: "Total debt stood at 999 crore for the period.",
      },
    ]);

    const { payload, audit } = await verifyFundamentalsPayload(input, REF);

    expect(payload).toBe(input);
    expect(JSON.stringify(input)).toBe(before);
    // The audit is still produced — verdicts are kept, they just no longer
    // reach the data.
    expect(audit).not.toBeNull();
  });

  it("records disagreement as a conflict, never as a correction", async () => {
    // "corrected" is no longer a member of FieldVerificationStatus at all, so
    // this asserts the behaviour the type change guarantees: the audit still
    // surfaces the disagreement, and the payload keeps its own value.
    const input = basePayload({
      meta: {
        currency: "INR",
        financialCurrency: "INR",
        asOf: daysAgo(0),
        mostRecentQuarter: daysAgo(400),
      },
    });
    search.mockResolvedValue([
      {
        source: { tier: "tier1", name: "NSE India", url: "https://nseindia.com/x" },
        title: "Total debt",
        snippet: "Total debt stood at 999 crore for the period.",
      },
    ]);

    const { payload, audit } = await verifyFundamentalsPayload(input, REF);

    expect(payload.health.totalDebt).toBe(input.health.totalDebt);
    const statuses = new Set((audit?.fields ?? []).map((f) => f.status));
    expect(statuses.has("conflict" as const)).toBe(true);
  });
});
