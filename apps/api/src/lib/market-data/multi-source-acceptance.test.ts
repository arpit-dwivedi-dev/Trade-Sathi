import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSecEdgarStatements } from "./provider/sec-edgar-statements.js";
import { getNseStatements } from "./provider/nse-statements.js";
import { deriveMetrics } from "../../services/fundamentals/derive-metrics.js";
import { resolveReportingProfile } from "../../services/fundamentals/reporting-profile.js";

/**
 * The concrete acceptance criterion from the multi-source fallback task:
 * TCS and NVDA can each reach 8+ usable contiguous quarters from official
 * filings alone, and revenueGrowth/earningsGrowth — which need exactly that —
 * flip from the "missing" the committed Yahoo-only golden fixtures show
 * (tests/golden/fixtures/tcs-nse.json, nvda-nasdaq.json top out at 6-7
 * quarters) to a derived, reliable value. No network: both adapters are fed
 * the same real captures their own unit tests use.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "fixtures", "external-sources");

const NVDA_COMPANY_FACTS: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, "nvda-companyfacts.json"), "utf8"));
const TICKER_MAP = { "0": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" } };

const TCS_RESULT_ROWS: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, "tcs-financial-results.json"), "utf8"));
const TCS_XBRL_DIR = join(FIXTURE_DIR, "tcs-xbrl");
const TCS_XBRL_BY_NAME = new Map<string, string>();
for (const file of readdirSync(TCS_XBRL_DIR)) {
  TCS_XBRL_BY_NAME.set(file, readFileSync(join(TCS_XBRL_DIR, file), "utf8"));
}

describe("multi-source fallback: revenueGrowth/earningsGrowth acceptance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("NVDA: SEC EDGAR alone supplies enough contiguous quarters to derive growth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("company_tickers")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(TICKER_MAP) } as Response);
        }
        if (url.includes("companyfacts")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(NVDA_COMPANY_FACTS) } as Response);
        }
        throw new Error(`unexpected URL: ${url}`);
      }),
    );

    const statements = await getSecEdgarStatements("NVDA");
    expect(statements).not.toBeNull();

    const profile = resolveReportingProfile({
      exchange: "NASDAQ",
      fiscalYearEndMonthFromFilings: 1,
      reportingCurrency: "USD",
    });
    const metrics = deriveMetrics({ statements: statements!, profile });

    expect(metrics.revenueGrowth.reliability).toBe("ok");
    expect(metrics.revenueGrowth.value).not.toBeNull();
    expect(metrics.earningsGrowth.reliability).toBe("ok");
    expect(metrics.earningsGrowth.value).not.toBeNull();

    // The cash-flow and per-share chain, which needs more than contiguous
    // quarters: cash-flow lines only exist year-to-date in a 10-Q, and share
    // counts are filed under the "shares" unit rather than USD. Both were
    // silently unreadable, taking operating cash flow, capex, free cash flow
    // and trailing EPS down with them.
    for (const key of ["operatingCashFlow", "capex", "fcf", "dilutedShares", "trailingEps"] as const) {
      expect(metrics[key].reliability, `${key} should be derivable`).toBe("ok");
      expect(metrics[key].value, `${key} should have a value`).not.toBeNull();
    }

    // FCF is OCF less capex and nothing else.
    expect(metrics.fcf.value).toBeCloseTo(
      (metrics.operatingCashFlow.value ?? 0) - (metrics.capex.value ?? 0),
      -3,
    );

    // Trailing P/E stops here on purpose: it needs a live price, and an
    // official-filing source never carries one. It resolves only once Yahoo's
    // spot is merged in, which is why Yahoo stays a required source rather
    // than a fallback that can be skipped.
    expect(metrics.trailingPe.reliability).toBe("missing");
  });

  it("TCS: NSE alone supplies enough contiguous quarters to derive growth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("corporates-financial-results")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(TCS_RESULT_ROWS) } as Response);
        }
        const name = url.split("FIXTURE_XBRL/")[1];
        if (name && TCS_XBRL_BY_NAME.has(name)) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve(TCS_XBRL_BY_NAME.get(name)) } as Response);
        }
        throw new Error(`unexpected URL: ${url}`);
      }),
    );

    const statements = await getNseStatements("TCS");
    expect(statements).not.toBeNull();
    expect(statements!.quarterly.length).toBeGreaterThanOrEqual(8);

    const profile = resolveReportingProfile({
      exchange: "NSE",
      fiscalYearEndMonthFromFilings: 3,
      reportingCurrency: "INR",
    });
    const metrics = deriveMetrics({ statements: statements!, profile });

    expect(metrics.revenueGrowth.reliability).toBe("ok");
    expect(metrics.revenueGrowth.value).not.toBeNull();
    expect(metrics.earningsGrowth.reliability).toBe("ok");
    expect(metrics.earningsGrowth.value).not.toBeNull();
  });

  it("regression: fewer than 8 combined contiguous quarters still reports growth as missing", () => {
    // The existing Yahoo-only golden fixtures (tcs-nse.json, nvda-nasdaq.json)
    // top out at 6-7 quarters and are untouched by this change — their
    // committed snapshots already assert revenueGrowth/earningsGrowth stay
    // "missing". This test only guards the invariant that the ceiling case
    // itself was not silently papered over by the new merge path: a bare
    // 6-quarter run, fed straight to deriveMetrics with no official source at
    // all, must still come back missing.
    const quarters = ["2025-01-31", "2025-04-30", "2025-07-31", "2025-10-31", "2026-01-31", "2026-04-30"].map(
      (periodEnd, i) => ({
        periodEnd,
        months: 3 as const,
        basis: "consolidated" as const,
        currency: "USD",
        source: "yahoo" as const,
        filingDate: null,
        revenue: 1_000 + i * 10,
        totalIncome: 1_000 + i * 10,
        otherIncome: null,
        costOfRevenue: null,
        grossProfit: null,
        operatingIncome: null,
        pretaxIncome: null,
        netIncome: 100 + i,
        dilutedShares: null,
        operatingCashFlow: null,
        capex: null,
        dividendsPaid: null,
        equity: null,
        totalDebt: null,
        cash: null,
        sharesOutstanding: null,
      }),
    );

    const profile = resolveReportingProfile({
      exchange: "NASDAQ",
      fiscalYearEndMonthFromFilings: 1,
      reportingCurrency: "USD",
    });
    const metrics = deriveMetrics({
      statements: {
        quarterly: quarters,
        annual: [],
        spot: {
          price: 100,
          asOf: "2026-09-04T10:00:00.000Z",
          marketCap: null,
          currency: "USD",
          financialCurrency: "USD",
          dividendDeclaredPerShare: null,
          dividendYield: null,
          mostRecentQuarter: "2026-04-30",
        },
        forward: [],
        corporateActions: [],
      },
      profile,
    });

    expect(metrics.revenueGrowth.reliability).toBe("missing");
    expect(metrics.earningsGrowth.reliability).toBe("missing");
  });
});
