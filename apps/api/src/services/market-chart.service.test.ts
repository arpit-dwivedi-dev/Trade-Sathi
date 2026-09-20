import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../lib/market-data/types.js";

// This module pulls in the Supabase admin client (and through it env
// validation) at import time; the candle logic under test never touches it.
vi.mock("../lib/supabase.js", () => ({ supabaseAdmin: {} }));

const getHistoricalCandles = vi.fn();
const getQuote = vi.fn();
// Only the provider class is replaced; resolveUpstreamRequest is the real
// range/interval bucketing, which is what the cache key is built from and so
// is part of the behaviour under test.
vi.mock("../lib/market-data/provider/yahoo-finance-provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/market-data/provider/yahoo-finance-provider.js")>()),
  YahooFinanceMarketDataProvider: class {
    getHistoricalCandles = getHistoricalCandles;
    getQuote = getQuote;
  },
}));

const {
  candleSpecFor,
  clearCandleCache,
  explicitCandleSpec,
  getCandlesForInstrument,
  getQuoteForInstrument,
  subtractDays,
  WORKSPACE_INTERVALS,
} = await import("./market-chart.service.js");

const ref = {
  instrumentId: "i1",
  instrumentKey: "RELIANCE.NS",
  exchange: "NSE",
  symbol: "RELIANCE",
  name: "Reliance Industries",
};

function candleOn(date: string): Candle {
  return { timestamp: `${date}T00:00:00Z`, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

describe("candleSpecFor", () => {
  it("uses intraday candles for windows too short to have daily ones", () => {
    expect(candleSpecFor(1)).toMatchObject({ unit: "minutes", interval: 1 });
    expect(candleSpecFor(7)).toMatchObject({ unit: "minutes", interval: 30 });
  });

  it("uses daily candles beyond a week", () => {
    expect(candleSpecFor(8)).toMatchObject({ unit: "days", interval: 1 });
    expect(candleSpecFor(365)).toMatchObject({ unit: "days", interval: 1 });
  });
});

describe("explicitCandleSpec", () => {
  it("maps every workspace timeframe to a valid spec", () => {
    expect(WORKSPACE_INTERVALS.map(explicitCandleSpec)).toEqual([
      { unit: "minutes", interval: 1, label: "1m" },
      { unit: "minutes", interval: 5, label: "5m" },
      { unit: "minutes", interval: 15, label: "15m" },
      { unit: "minutes", interval: 30, label: "30m" },
      { unit: "minutes", interval: 60, label: "1H" },
      { unit: "days", interval: 1, label: "1D" },
    ]);
  });
});

describe("getCandlesForInstrument", () => {
  beforeEach(() => {
    clearCandleCache();
    getHistoricalCandles.mockReset();
    getQuote.mockReset();
  });

  it("drops candles older than the requested window", async () => {
    const today = new Date().toISOString().slice(0, 10);
    getHistoricalCandles.mockResolvedValue([
      candleOn(subtractDays(today, 400)),
      candleOn(subtractDays(today, 5)),
    ]);

    const window = await getCandlesForInstrument(ref, 30);

    expect(window.candles).toHaveLength(1);
    expect(window.marketDataDate).toBe(subtractDays(today, 5));
    expect(window.timeframeLabel).toBe("1D · 30d");
  });

  it("serves the last session when today has no candles (weekend/holiday)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    getHistoricalCandles.mockResolvedValue([candleOn(subtractDays(today, 2))]);

    const window = await getCandlesForInstrument(ref, 1);

    expect(window.candles).toHaveLength(1);
    expect(window.marketDataDate).toBe(subtractDays(today, 2));
  });

  it("never asks Yahoo for a one-day range, which is empty outside market hours", async () => {
    const today = new Date().toISOString().slice(0, 10);
    getHistoricalCandles.mockResolvedValue([candleOn(subtractDays(today, 2))]);

    await getCandlesForInstrument(ref, 1);

    // range=1d is the request that returned nothing from the deployed API on
    // a weekend; five days always contains a session.
    expect(getHistoricalCandles).toHaveBeenCalledWith(
      expect.objectContaining({ fromDate: subtractDays(today, 1), toDate: today }),
    );
    const { resolveUpstreamRequest } = await import(
      "../lib/market-data/provider/yahoo-finance-provider.js"
    );
    expect(
      resolveUpstreamRequest({
        instrumentKey: ref.instrumentKey,
        unit: "minutes",
        interval: 1,
        fromDate: subtractDays(today, 1),
        toDate: today,
      }).range,
    ).toBe("5d");
  });

  it("keeps a one-day window to the latest session when the range carries earlier ones", async () => {
    const today = new Date().toISOString().slice(0, 10);
    getHistoricalCandles.mockResolvedValue([
      candleOn(subtractDays(today, 3)),
      candleOn(subtractDays(today, 2)),
    ]);

    const window = await getCandlesForInstrument(ref, 1);

    expect(window.candles).toHaveLength(1);
    expect(window.marketDataDate).toBe(subtractDays(today, 2));
  });

  it("serves a repeat request from cache instead of hitting the provider again", async () => {
    getHistoricalCandles.mockResolvedValue([candleOn(new Date().toISOString().slice(0, 10))]);

    await getCandlesForInstrument(ref, 90);
    await getCandlesForInstrument(ref, 90);

    expect(getHistoricalCandles).toHaveBeenCalledTimes(1);
  });

  it("does not share a cache entry between different windows", async () => {
    getHistoricalCandles.mockResolvedValue([candleOn(new Date().toISOString().slice(0, 10))]);

    await getCandlesForInstrument(ref, 90);
    await getCandlesForInstrument(ref, 30);

    expect(getHistoricalCandles).toHaveBeenCalledTimes(2);
  });

  it("shares one upstream fetch between windows that resolve to the same range", async () => {
    const today = new Date().toISOString().slice(0, 10);
    getHistoricalCandles.mockResolvedValue([
      candleOn(subtractDays(today, 80)),
      candleOn(subtractDays(today, 5)),
    ]);

    // 60d and 90d are both range=3mo interval=1d upstream.
    const wide = await getCandlesForInstrument(ref, 90);
    const narrow = await getCandlesForInstrument(ref, 60);

    expect(getHistoricalCandles).toHaveBeenCalledTimes(1);
    // The shared entry is the untrimmed response; each caller still gets only
    // the candles inside its own window.
    expect(wide.candles).toHaveLength(2);
    expect(narrow.candles).toHaveLength(1);
  });

  it("collapses concurrent misses into a single upstream fetch", async () => {
    let release: (candles: Candle[]) => void = () => {};
    getHistoricalCandles.mockReturnValue(
      new Promise<Candle[]>((resolve) => {
        release = resolve;
      }),
    );

    const both = Promise.all([
      getCandlesForInstrument(ref, 90),
      getCandlesForInstrument(ref, 90),
    ]);
    release([candleOn(new Date().toISOString().slice(0, 10))]);
    const [first, second] = await both;

    expect(getHistoricalCandles).toHaveBeenCalledTimes(1);
    expect(first.candles).toEqual(second.candles);
  });

  it("does not cache a failed fetch", async () => {
    getHistoricalCandles.mockRejectedValueOnce(new Error("upstream down"));
    getHistoricalCandles.mockResolvedValueOnce([candleOn(new Date().toISOString().slice(0, 10))]);

    await expect(getCandlesForInstrument(ref, 90)).rejects.toThrow("upstream down");
    const retried = await getCandlesForInstrument(ref, 90);

    expect(retried.candles).toHaveLength(1);
    expect(getHistoricalCandles).toHaveBeenCalledTimes(2);
  });

  it("uses an explicit spec instead of deriving one from lookbackDays", async () => {
    getHistoricalCandles.mockResolvedValue([candleOn(new Date().toISOString().slice(0, 10))]);

    // candleSpecFor(5) would derive 30m; the explicit spec overrides that.
    const window = await getCandlesForInstrument(ref, 5, explicitCandleSpec("15m"));

    expect(window.spec).toEqual({ unit: "minutes", interval: 15, label: "15m" });
    expect(window.timeframeLabel).toBe("15m · 5d");
    expect(window.intervalMinutes).toBe(15);
  });
});

describe("getQuoteForInstrument", () => {
  beforeEach(() => {
    clearCandleCache();
    getQuote.mockReset();
  });

  it("serves a repeat quote from cache instead of hitting the provider again", async () => {
    getQuote.mockResolvedValue({
      instrumentKey: ref.instrumentKey,
      lastPrice: 100,
      asOf: new Date().toISOString(),
    });

    await getQuoteForInstrument(ref);
    await getQuoteForInstrument(ref);

    expect(getQuote).toHaveBeenCalledTimes(1);
  });
});
