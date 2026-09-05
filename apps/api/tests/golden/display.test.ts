import { formatAmount, formatPercent } from "../../src/services/fundamentals/display.js";
import { resolveReportingProfile } from "../../src/services/fundamentals/reporting-profile.js";

const NSE = resolveReportingProfile({
  exchange: "NSE",
  fiscalYearEndMonthFromFilings: 3,
  reportingCurrency: "INR",
});
const NASDAQ = resolveReportingProfile({
  exchange: "NASDAQ",
  fiscalYearEndMonthFromFilings: 1,
  reportingCurrency: "USD",
});

describe("display units", () => {
  it("writes Indian figures in crore with Indian digit grouping", () => {
    // TCS FY2026 revenue. An Indian reader does not read "INR 2.67 trillion".
    expect(formatAmount(2_670_210_000_000, NSE)).toBe("₹2,67,021 cr");
  });

  it("writes US figures in billions", () => {
    expect(formatAmount(302_969_000_000, NASDAQ)).toBe("$302.97B");
  });

  it("drops to millions below a billion", () => {
    expect(formatAmount(973_000_000, NASDAQ)).toBe("$973.0M");
  });

  it("says so rather than printing a placeholder when a figure is absent", () => {
    expect(formatAmount(null, NSE)).toBe("not reported");
    expect(formatPercent(null)).toBe("not reported");
  });

  it("renders fractions as percentages, never as raw floats", () => {
    // We shipped 0.38509998 to a user once.
    expect(formatPercent(0.2494932)).toBe("24.95%");
    expect(formatPercent(0.38509998)).toBe("38.51%");
  });
});
