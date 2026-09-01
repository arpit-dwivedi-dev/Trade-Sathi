import { beforeEach, describe, expect, it, vi } from "vitest";

const range = vi.fn();
const order = vi.fn(() => ({ range }));
const select = vi.fn(() => ({ order }));
const from = vi.fn(() => ({ select }));

vi.mock("../lib/supabase.js", () => ({ supabaseAdmin: { from } }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { clearInstrumentCache, searchInstruments } = await import("./instruments.service.js");

function row(symbol: string, name: string, id = symbol) {
  return { id, exchange: "NSE", symbol, name, instrument_type: "EQUITY" };
}

const catalogue = [
  row("REL", "Rel Small Cap"),
  row("RELIANCE", "Reliance Industries"),
  row("RELIGARE", "Religare Enterprises"),
  row("TATASTEEL", "Tata Steel"),
  row("INFY", "Infosys Reliable Systems"),
];

beforeEach(() => {
  clearInstrumentCache();
  from.mockClear();
  range.mockReset();
  range.mockResolvedValue({ data: catalogue, error: null });
});

describe("searchInstruments", () => {
  it("ranks exact symbol, then symbol prefix, then name match", async () => {
    const results = await searchInstruments("rel");

    expect(results.map((r) => r.symbol)).toEqual([
      "REL", // exact symbol
      "RELIANCE", // symbol prefix
      "RELIGARE", // symbol prefix
      "INFY", // name contains "rel" (Reliable)
    ]);
  });

  it("is case insensitive", async () => {
    const results = await searchInstruments("ReLiAnCe");
    expect(results[0]?.symbol).toBe("RELIANCE");
  });

  it("returns nothing for a blank query without loading the catalogue", async () => {
    expect(await searchInstruments("   ")).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("loads the catalogue once and serves later searches from memory", async () => {
    await searchInstruments("rel");
    await searchInstruments("tata");
    await searchInstruments("infy");

    expect(from).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent cold searches into a single catalogue load", async () => {
    let release: (value: unknown) => void = () => {};
    range.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const both = Promise.all([searchInstruments("rel"), searchInstruments("tata")]);
    release({ data: catalogue, error: null });
    await both;

    expect(from).toHaveBeenCalledTimes(1);
  });

  it("pages past PostgREST's 1000-row response cap", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => row(`SYM${i}`, `Name ${i}`, `id${i}`));
    range.mockReset();
    range.mockResolvedValueOnce({ data: first, error: null });
    range.mockResolvedValueOnce({ data: [row("LASTONE", "Last One")], error: null });

    const results = await searchInstruments("lastone");

    expect(range).toHaveBeenCalledTimes(2);
    expect(range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(range).toHaveBeenNthCalledWith(2, 1000, 1999);
    // An instrument on the second page is findable — the whole point of paging.
    expect(results.map((r) => r.symbol)).toEqual(["LASTONE"]);
  });

  it("caps results", async () => {
    range.mockResolvedValue({
      data: Array.from({ length: 40 }, (_, i) => row(`AAA${i}`, `Alpha ${i}`, `id${i}`)),
      error: null,
    });

    expect(await searchInstruments("aaa")).toHaveLength(15);
  });

  it("serves the stale catalogue when a refresh fails", async () => {
    vi.useFakeTimers();
    try {
      await searchInstruments("rel");

      range.mockRejectedValue(new Error("supabase down"));
      vi.advanceTimersByTime(11 * 60_000);

      const results = await searchInstruments("rel");
      expect(results[0]?.symbol).toBe("REL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a failure when there is no cached copy at all", async () => {
    range.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(searchInstruments("rel")).rejects.toThrow("Instrument catalogue load failed");
  });
});
