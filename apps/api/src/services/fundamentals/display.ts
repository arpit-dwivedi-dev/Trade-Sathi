import type { ReportingProfile } from "@chartanalyzer/shared";

/**
 * How figures are written for a reader in this market.
 *
 * Indian readers do not read "INR 2.67 trillion". They read crore, grouped
 * the Indian way: ₹2,67,021 cr. US readers read billions. The unit comes off
 * the ReportingProfile rather than off a currency code, because the unit is a
 * property of the audience's convention, not of the currency itself.
 */

const CRORE = 1e7;
const BILLION = 1e9;

/** Indian digit grouping: last three digits, then pairs (2,67,021). */
function groupIndian(value: number): string {
  const [whole] = Math.round(value).toString().split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  if (digits.length <= 3) return (negative ? "-" : "") + digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped},${last3}`;
}

/**
 * An absolute currency amount, in the unit this market reads.
 *
 * `amount` is in whole reporting-currency units, exactly as filed.
 */
export function formatAmount(
  amount: number | null,
  profile: ReportingProfile,
  currency = profile.reportingCurrency,
): string {
  if (amount === null) return "not reported";

  if (profile.displayUnit === "crore") {
    const symbol = currency === "INR" ? "₹" : `${currency} `;
    return `${symbol}${groupIndian(amount / CRORE)} cr`;
  }

  const billions = amount / BILLION;
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (Math.abs(billions) >= 1) {
    return `${symbol}${billions.toFixed(2)}B`;
  }
  return `${symbol}${(amount / 1e6).toFixed(1)}M`;
}

/** A fraction as a percentage, e.g. 0.2495 becomes "24.95%". */
export function formatPercent(fraction: number | null, decimals = 2): string {
  if (fraction === null) return "not reported";
  return `${(fraction * 100).toFixed(decimals)}%`;
}
