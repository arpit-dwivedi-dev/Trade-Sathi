import { describe, expect, it } from "vitest";
import { renderCandlestickChart } from "./chart-image.service.js";
import type { Candle } from "../lib/market-data/types.js";

function makeCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i;
    return {
      timestamp: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00+05:30`,
      open: base,
      high: base + 2,
      low: base - 2,
      close: base + 1,
      volume: 1000 + i * 10,
    };
  });
}

describe("renderCandlestickChart", () => {
  it("produces a valid PNG buffer for real candle data", async () => {
    const buffer = await renderCandlestickChart(makeCandles(30), {
      symbol: "RELIANCE",
      name: "Reliance Industries",
      exchange: "NSE",
      timeframeLabel: "1D",
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    // PNG magic bytes.
    expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("rejects an empty candle set rather than rendering a blank chart", async () => {
    await expect(
      renderCandlestickChart([], {
        symbol: "RELIANCE",
        name: "Reliance Industries",
        exchange: "NSE",
        timeframeLabel: "1D",
      }),
    ).rejects.toThrow();
  });
});
