import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../lib/market-data/types.js";

// This module pulls in the Supabase admin client (and through it env
// validation) at import time; the candle logic under test never touches it.
vi.mock("../lib/supabase.js", () => ({ supabaseAdmin: {} }));

const getHistoricalCandles = vi.fn();
vi.mock("../lib/market-data/yahoo-finance-provider.js", () => ({
  YahooFinanceMarketDataProvider: class {
    getHistoricalCandles = getHistoricalCandles;
    getQuote = vi.fn();
  },
}));

const { candleSpecFor, clearCandleCache, getCandlesForInstrument, subtractDays } = await import(
  "./market-chart.service.js"
);

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
    expect(candleSpecFor(1)).toMatchObject({ unit: "minutes", interval: 5 });
    expect(candleSpecFor(7)).toMatchObject({ unit: "minutes", interval: 30 });
  });

  it("uses daily candles beyond a week", () => {
    expect(candleSpecFor(8)).toMatchObject({ unit: "days", interval: 1 });
    expect(candleSpecFor(365)).toMatchObject({ unit: "days", interval: 1 });
  });
});

describe("getCandlesForInstrument", () => {
  beforeEach(() => {
    clearCandleCache();
    getHistoricalCandles.mockReset();
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
});
