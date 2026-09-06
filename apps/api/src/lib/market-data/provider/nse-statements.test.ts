import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getNseStatements } from "./nse-statements.js";

/**
 * Fixtures captured live from nseindia.com (Sept 2026): 10 real TCS
 * quarterly filings (metadata + the actual linked XBRL). No network in this
 * test — fetch is mocked and serves these files back by name.
 */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "tests", "fixtures", "external-sources");

const RESULT_ROWS = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "tcs-financial-results.json"), "utf8"),
) as Record<string, unknown>[];
const XBRL_DIR = join(FIXTURE_DIR, "tcs-xbrl");
const XBRL_BY_NAME = new Map<string, string>();
for (const file of readdirSync(XBRL_DIR)) {
  XBRL_BY_NAME.set(file, readFileSync(join(XBRL_DIR, file), "utf8"));
}

/** Real subject lines from NSE's corporate-actions feed. */
const ACTION_ROWS = [
  { subject: "Dividend - Rs 4 Per Share", exDate: recentDate(30) },
  { subject: "Bonus 1:2", exDate: recentDate(90) },
  { subject: "Face Value Split From Rs.10 To Re.1", exDate: recentDate(200) },
  { subject: "Buy Back of Shares", exDate: recentDate(300) },
  // Older than the window the share-count rule compares across.
  { subject: "Bonus 1:1", exDate: recentDate(900) },
];

/** An NSE-format date this many days before today. */
function recentDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function mockFetch(
  rows: unknown = RESULT_ROWS,
  xbrlOverrides: Map<string, string> = new Map(),
  actions: unknown = ACTION_ROWS,
) {
  return vi.fn((url: string) => {
    if (url.includes("corporates-corporateActions")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(actions) } as Response);
    }
    if (url.includes("corporates-financial-results")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) } as Response);
    }
    const name = url.split("FIXTURE_XBRL/")[1];
    const xml = name ? (xbrlOverrides.get(name) ?? XBRL_BY_NAME.get(name)) : undefined;
    if (xml !== undefined) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(xml) } as Response);
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/** The fixture filing for one quarter end, by the name the mock serves it under. */
function fixtureNameFor(periodEnd: string): string {
  const match = RESULT_ROWS.find((row) => {
    const parsed = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(row.toDate));
    return parsed ? `${parsed[3]}-${MONTHS[parsed[2]]}-${parsed[1]}` === periodEnd : false;
  });
  if (!match) throw new Error(`no fixture row for ${periodEnd}`);
  return String(match.xbrl).split("FIXTURE_XBRL/")[1];
}

describe("getNseStatements", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts at least 8 contiguous consolidated quarters for TCS with correct provenance", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getNseStatements("TCS");
    expect(result).not.toBeNull();
    const quarterly = result!.quarterly;

    expect(quarterly.length).toBeGreaterThanOrEqual(8);
    for (const period of quarterly) {
      expect(period.source).toBe("nse-bse");
      expect(period.basis).toBe("consolidated");
      expect(period.currency).toBe("INR");
      expect(period.revenue).not.toBeNull();
      expect(period.netIncome).not.toBeNull();
      // Not reported at quarterly cadence by NSE's regulatory filing.
      expect(period.operatingCashFlow).toBeNull();
    }
  });

  it("reads the balance sheet from the half-yearly filings, and only those", async () => {
    // SEBI requires a balance sheet twice a year, with the September and March
    // results. Treating every filing as if it carried none — which is what
    // this adapter did — left equity, debt and cash null on every Indian
    // company, and return on equity unreportable with them.
    vi.stubGlobal("fetch", mockFetch());

    const quarterly = (await getNseStatements("TCS"))!.quarterly;
    const halfYearly = quarterly.filter((q) => /-(03|09)-\d\d$/.test(q.periodEnd));
    const interim = quarterly.filter((q) => /-(06|12)-\d\d$/.test(q.periodEnd));

    expect(halfYearly.length).toBeGreaterThan(0);
    expect(halfYearly.some((q) => q.equity !== null && q.equity > 0)).toBe(true);
    // An interim quarter files no balance sheet, so nothing is invented for it.
    expect(interim.every((q) => q.equity === null)).toBe(true);
  });

  it("synthesizes an annual period by summing four same-fiscal-year quarters", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getNseStatements("TCS");
    expect(result!.annual.length).toBeGreaterThan(0);
    const fy2024 = result!.annual.find((a) => a.periodEnd === "2024-03-31");
    expect(fy2024).toBeDefined();
    expect(fy2024!.reconstructed).toBe(true);
    expect(fy2024!.revenue).toBeGreaterThan(0);
  });

  it("recovers a filing that declares no OneD context at all, by proving it against the year-to-date chain", async () => {
    // The real Dec-2022 TCS filing tags every fact contextRef="OneD" while
    // declaring no OneD context anywhere in the document — invalid XBRL, and
    // unreadable by a date cross-check. Its figures are still provable: the
    // year-to-date series, differenced across the fiscal year, gives the
    // standalone quarter exactly.
    vi.stubGlobal("fetch", mockFetch());

    const result = await getNseStatements("TCS");
    const recovered = result!.quarterly.find((q) => q.periodEnd === "2022-12-31");

    expect(recovered).toBeDefined();
    expect(recovered!.revenue).toBe(582_290_000_000);
    expect(recovered!.basis).toBe("consolidated");
  });

  it("drops a filing whose quarter figure contradicts the year-to-date arithmetic", async () => {
    // The defect this guard exists for: a year-to-date figure mislabelled as
    // the quarter. Here the Dec-2023 filing's quarter revenue is rewritten to
    // a value that cannot be the difference between two consecutive
    // year-to-date figures, and must therefore be refused rather than
    // reported as a quarter.
    const name = fixtureNameFor("2023-12-31");
    const original = XBRL_BY_NAME.get(name)!;
    const corrupted = original.replace(
      /(<in-bse-fin:RevenueFromOperations contextRef="OneD"[^>]*>)[^<]*/,
      "$19999999999999.00",
    );
    expect(corrupted).not.toBe(original); // the fixture really was rewritten

    vi.stubGlobal("fetch", mockFetch(RESULT_ROWS, new Map([[name, corrupted]])));

    const result = await getNseStatements("TCS");
    const revenues = (result?.quarterly ?? [])
      .filter((q) => q.periodEnd === "2023-12-31")
      .map((q) => q.revenue);

    expect(revenues).not.toContain(9_999_999_999_999);
  });

  it("prefers Consolidated over Non-Consolidated for the same quarter", async () => {
    const rows = [
      ...RESULT_ROWS,
      {
        ...RESULT_ROWS[0],
        consolidated: "Non-Consolidated",
        xbrl: "FIXTURE_XBRL/should-not-be-fetched.xml",
      },
    ];
    const fetchMock = mockFetch(rows);
    vi.stubGlobal("fetch", fetchMock);

    await getNseStatements("TCS");
    const fetchedUrls = fetchMock.mock.calls.map((call) => call[0]);
    expect(fetchedUrls.some((u) => u.includes("should-not-be-fetched"))).toBe(false);
  });

  it("resolves to null, not an error, when the symbol has no results", async () => {
    vi.stubGlobal("fetch", mockFetch([]));

    const result = await getNseStatements("NOTAREALSYMBOL");
    expect(result).toBeNull();
  });

  it("resolves to null, not an error, on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("network down");
      }),
    );

    const result = await getNseStatements("TCS");
    expect(result).toBeNull();
  });

  it("leaves the live quote and forward estimates for Yahoo to supply", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const result = await getNseStatements("TCS");
    expect(result!.spot.price).toBeNull();
    expect(result!.forward).toEqual([]);
  });

  describe("corporate actions", () => {
    // The only such feed the pipeline has — Yahoo supplies none — so without
    // it every Indian share-count move is unexplained and the plausibility
    // gate marks diluted shares and every per-share figure unreliable.
    it("reads splits, bonuses and buybacks, and ignores dividends", async () => {
      vi.stubGlobal("fetch", mockFetch());

      const actions = (await getNseStatements("TCS"))!.corporateActions!;

      expect(actions.map((a) => a.kind).sort()).toEqual(["bonus", "buyback", "split"]);
      // "Bonus 1:2" — one new share per two held, so 1.5 shares per old one.
      expect(actions.find((a) => a.kind === "bonus")?.ratio).toBeCloseTo(1.5, 10);
      // "From Rs.10 To Re.1" — ten shares where there was one.
      expect(actions.find((a) => a.kind === "split")?.ratio).toBeCloseTo(10, 10);
    });

    it("drops an action too old to explain a year-on-year share-count move", async () => {
      vi.stubGlobal("fetch", mockFetch());

      const actions = (await getNseStatements("TCS"))!.corporateActions!;

      // The 1:1 bonus in the fixture is ~900 days back. Left in the list it
      // would suppress the share-count rule permanently for any company that
      // ever issued a bonus.
      expect(actions.filter((a) => a.kind === "bonus")).toHaveLength(1);
      expect(actions.every((a) => a.date >= "2000-01-01")).toBe(true);
    });

    it("reports null — 'could not check' — rather than [] when the feed fails", async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal("fetch", (url: string) => {
        if (url.includes("corporates-corporateActions")) throw new Error("network down");
        return fetchMock(url);
      });

      // Null and [] mean different things to the plausibility gate: "could
      // not check" must never be reported as "checked, none found".
      expect((await getNseStatements("TCS"))!.corporateActions).toBeNull();
    });
  });
});
