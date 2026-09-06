import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSecEdgarStatements, resetSecEdgarStatementCacheForTests } from "./sec-edgar-statements.js";

/**
 * Fixture captured live from data.sec.gov (Sept 2026), trimmed to the
 * concepts this adapter reads. No network in this test — fetch is mocked.
 */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "tests", "fixtures", "external-sources");

const NVDA_COMPANY_FACTS: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, "nvda-companyfacts.json"), "utf8"));
const TICKER_MAP = { "0": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" } };

function mockFetch(overrides: { tickerMap?: unknown; companyFacts?: unknown; tickerMapFails?: boolean } = {}) {
  return vi.fn((url: string) => {
    if (url.includes("company_tickers")) {
      if (overrides.tickerMapFails) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides.tickerMap ?? TICKER_MAP) } as Response);
    }
    if (url.includes("companyfacts")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.companyFacts ?? NVDA_COMPANY_FACTS),
      } as Response);
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
}

describe("getSecEdgarStatements", () => {
  beforeEach(() => {
    resetSecEdgarStatementCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts at least 8 contiguous quarters for NVDA with correct provenance", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getSecEdgarStatements("NVDA");
    expect(result).not.toBeNull();
    const quarterly = result!.quarterly;

    expect(quarterly.length).toBeGreaterThanOrEqual(8);
    for (const period of quarterly) {
      expect(period.source).toBe("sec-edgar");
      expect(period.basis).toBe("consolidated");
      expect(period.currency).toBe("USD");
    }

    // Every quarter is 80-100 days from the next — the same contiguity test
    // derive-metrics.ts applies.
    for (let i = 1; i < quarterly.length; i++) {
      const gap =
        (new Date(quarterly[i].periodEnd).getTime() - new Date(quarterly[i - 1].periodEnd).getTime()) /
        86_400_000;
      expect(gap).toBeGreaterThanOrEqual(80);
      expect(gap).toBeLessThanOrEqual(100);
    }
  });

  it("derives the Q4 gap from the 10-K minus Q1-Q3, marked as derived", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getSecEdgarStatements("NVDA");
    const derivedQuarters = result!.quarterly.filter((q) => q.reconstructed);

    expect(derivedQuarters.length).toBeGreaterThan(0);
    for (const q of derivedQuarters) {
      expect(q.revenue).not.toBeNull();
      expect(q.netIncome).not.toBeNull();
    }

    // NVDA files no standalone Q4, so every fiscal-year-end quarter is derived.
    expect(derivedQuarters.map((q) => q.periodEnd)).toContain("2026-01-25");
  });

  it("reconciles the four quarters of a fiscal year against that year's 10-K", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getSecEdgarStatements("NVDA");
    // Fiscal 2026: the four quarters must sum to the audited annual figure,
    // which is the whole point of backing Q2-Q4 out of the year-to-date chain.
    const fy = result!.annual.find((a) => a.periodEnd === "2026-01-25");
    expect(fy).toBeDefined();

    const fyQuarters = ["2025-04-27", "2025-07-27", "2025-10-26", "2026-01-25"].map((end) => {
      const quarter = result!.quarterly.find((q) => q.periodEnd === end);
      expect(quarter).toBeDefined();
      return quarter!;
    });

    for (const line of ["revenue", "netIncome", "operatingCashFlow"] as const) {
      const summed = fyQuarters.reduce((total, q) => total + (q[line] ?? Number.NaN), 0);
      expect(summed).toBe(fy![line]);
    }
  });

  it("reads share counts, which are filed under the 'shares' unit and not USD", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getSecEdgarStatements("NVDA");
    // Directly reported quarters carry a weighted-average diluted share count.
    // A weighted average is not additive, so it is never differenced out of a
    // year-to-date figure — the fiscal-year-end quarter legitimately has none.
    const withShares = result!.quarterly.filter((q) => q.dilutedShares !== null);

    expect(withShares.length).toBeGreaterThanOrEqual(8);
    for (const q of withShares) {
      expect(q.dilutedShares).toBeGreaterThan(0);
    }
  });

  it("supplies four contiguous quarters of cash-flow lines, which 10-Qs report year-to-date", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getSecEdgarStatements("NVDA");
    const recent = result!.quarterly.slice(-4);

    // Without year-to-date differencing only Q1 of each year carries these, so
    // no trailing-twelve-month window could ever be built and free cash flow
    // was unreportable regardless of how much revenue history existed.
    for (const q of recent) {
      expect(q.operatingCashFlow).not.toBeNull();
      expect(q.capex).not.toBeNull();
      expect(q.capex).toBeGreaterThan(0); // normalised to a positive magnitude
    }
  });

  it("carries the real SEC filing date on each directly-reported period", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getSecEdgarStatements("NVDA");
    const directlyReported = result!.quarterly.filter((q) => !q.reconstructed);

    expect(directlyReported.length).toBeGreaterThan(0);
    for (const q of directlyReported) {
      expect(q.filingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("resolves to null, not an error, when the symbol has no CIK", async () => {
    vi.stubGlobal("fetch", mockFetch({ tickerMap: {} }));

    const result = await getSecEdgarStatements("NOTAREALTICKER");
    expect(result).toBeNull();
  });

  it("resolves to null, not an error, on a network failure", async () => {
    vi.stubGlobal("fetch", mockFetch({ tickerMapFails: true }));

    const result = await getSecEdgarStatements("NVDA");
    expect(result).toBeNull();
  });

  it("leaves spot/forward/corporateActions for Yahoo to supply", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getSecEdgarStatements("NVDA");
    expect(result!.spot.price).toBeNull();
    expect(result!.forward).toEqual([]);
    expect(result!.corporateActions).toBeNull();
  });

  it("does not mistake a 10-Q's trailing-twelve-months fact for a fiscal year", async () => {
    // Verified live on Amazon: its 2009-2010 era 10-Qs additionally tag
    // NetIncomeLoss with a ~365-day fact ending on a QUARTER date (e.g.
    // 2008-07-01..2009-06-30, filed inside the 10-Q for fiscal Q2 2010) —
    // a trailing-twelve-months-as-of-that-quarter figure, not an audited
    // fiscal year. Trusting any 365-day span regardless of form inflated
    // Amazon's annual array from 18 real fiscal years to 74 entries, most of
    // them null-revenue noise on quarter-end dates — exactly the multi-year
    // history the AI analysis prompt reads, and the proximate cause of a
    // live "analysis came back in an unexpected format" report.
    const facts = {
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: [
                // A quarterly fact, so the adapter has something to report at
                // all — the defect under test is specific to the annual array.
                { start: "2014-01-01", end: "2014-03-31", val: 100_000_000, form: "10-Q", filed: "2014-04-24" },
              ],
            },
          },
          NetIncomeLoss: {
            units: {
              USD: [
                // The real fiscal year, from the 10-K.
                { start: "2013-01-01", end: "2013-12-31", val: 274_000_000, form: "10-K", filed: "2014-01-30" },
                { start: "2014-01-01", end: "2014-12-31", val: 274_000_000, form: "10-K", filed: "2015-01-30" },
                // The bogus TTM-as-of-Q2 fact, tagged inside a 10-Q.
                {
                  start: "2013-07-01",
                  end: "2014-06-30",
                  val: 588_000_000,
                  form: "10-Q",
                  filed: "2014-07-24",
                },
              ],
            },
          },
        },
      },
    };
    vi.stubGlobal("fetch", mockFetch({ companyFacts: facts }));

    const result = await getSecEdgarStatements("NVDA");

    expect(result!.annual.map((a) => a.periodEnd)).toEqual(["2013-12-31", "2014-12-31"]);
    expect(result!.annual.every((a) => a.periodEnd.endsWith("-12-31"))).toBe(true);
  });
});
