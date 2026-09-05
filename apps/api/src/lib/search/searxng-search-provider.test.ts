import { describe, expect, it } from "vitest";
import { classifyHost } from "./classify-host.js";

describe("classifyHost", () => {
  it("classifies India exchange/regulator domains as tier1", () => {
    expect(classifyHost("https://www.nseindia.com/x")).toBe("tier1");
    expect(classifyHost("https://www.bseindia.com/x")).toBe("tier1");
    expect(classifyHost("https://www.sebi.gov.in/x")).toBe("tier1");
  });

  it("classifies US exchange/regulator domains as tier1", () => {
    expect(classifyHost("https://www.sec.gov/x")).toBe("tier1");
    expect(classifyHost("https://www.nasdaq.com/x")).toBe("tier1");
    expect(classifyHost("https://www.nyse.com/x")).toBe("tier1");
  });

  it("classifies known India and US aggregators as tier2", () => {
    expect(classifyHost("https://www.moneycontrol.com/x")).toBe("tier2");
    expect(classifyHost("https://www.screener.in/x")).toBe("tier2");
    expect(classifyHost("https://www.stockanalysis.com/x")).toBe("tier2");
    expect(classifyHost("https://www.macrotrends.net/x")).toBe("tier2");
    expect(classifyHost("https://www.wsj.com/x")).toBe("tier2");
    expect(classifyHost("https://www.marketwatch.com/x")).toBe("tier2");
  });

  it("falls back to tier3 for an unlisted domain, including the provider's own source", () => {
    expect(classifyHost("https://finance.yahoo.com/quote/TCS.NS")).toBe("tier3");
    expect(classifyHost("https://some-random-blog.example/x")).toBe("tier3");
  });

  it("promotes a caller-supplied company domain to tier1", () => {
    expect(classifyHost("https://investor.costco.com/x", ["costco.com"])).toBe("tier1");
    expect(classifyHost("https://www.tcs.com/x", ["tcs.com"])).toBe("tier1");
  });

  it("returns tier3 for an unparseable URL rather than throwing", () => {
    expect(classifyHost("not a url")).toBe("tier3");
  });
});
