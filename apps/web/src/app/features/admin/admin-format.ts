import type { AdminFx, AdminLocation, MoneyByCurrency } from '@tradesathi/shared';

/**
 * Display helpers for the Admin panel. Money is minor units in, one currency
 * per call out — there is deliberately no helper that combines currencies.
 */

const CURRENCY_ORDER = ['INR', 'USD'];

/** "₹9,000" / "$12.00" for integer minor units of one currency. */
export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** USD amounts already in major units (AI cost is recorded that way). */
export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, 4),
  }).format(value);
}

/** Each currency of a MoneyByCurrency as its own entry, INR then USD then the rest. */
export function moneyEntries(byCurrency: MoneyByCurrency | null | undefined): {
  currency: string;
  label: string;
}[] {
  return Object.keys(byCurrency ?? {})
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((currency) => ({ currency, label: money(byCurrency![currency], currency) }));
}

function rank(currency: string): number {
  const i = CURRENCY_ORDER.indexOf(currency);
  return i === -1 ? CURRENCY_ORDER.length : i;
}

/** "31 Aug 2026, 14:05". */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** analyses.source values as the rest of the app names them. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  manual: 'Chart image',
  live: 'Live chart',
  watchlist_daily: 'Daily briefing',
  fundamentals: 'Fundamentals',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export type TagSeverity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** One colour vocabulary for every status column in the panel. */
export function statusSeverity(status: string): TagSeverity {
  switch (status) {
    case 'complete':
    case 'captured':
    case 'sent':
      return 'success';
    case 'failed':
      return 'danger';
    case 'processing':
    case 'queued':
    case 'created':
    case 'sent_partial':
      return 'warn';
    case 'refunded':
      return 'info';
    default:
      return 'secondary';
  }
}

export function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

/**
 * Every calendar day from the first to the last in `days` ("YYYY-MM-DD"), so a
 * trend chart shows a quiet day as zero instead of skipping it.
 */
export function continuousDays(days: readonly string[]): string[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort();
  const out: string[] = [];
  const cursor = new Date(`${sorted[0]}T00:00:00Z`);
  const last = new Date(`${sorted[sorted.length - 1]}T00:00:00Z`);
  while (cursor <= last) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** "42%" — or "—" when there is nothing to take a share of. */
export function pct(part: number, whole: number): string {
  if (!whole) return '—';
  const value = (part / whole) * 100;
  return `${value > 0 && value < 1 ? value.toFixed(1) : Math.round(value)}%`;
}

/**
 * The app's own status pill (components.css .st) for any status in the panel,
 * mapped through the same vocabulary as statusSeverity.
 */
export function stClass(status: string): string {
  switch (statusSeverity(status)) {
    case 'success':
      return 'st st-complete';
    case 'danger':
      return 'st st-failed';
    case 'warn':
    case 'info':
      return 'st st-processing';
    default:
      return 'st st-queued';
  }
}

const countryNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** "IN" → "India"; unknown codes come back as given. */
export function countryName(code: string): string {
  try {
    return countryNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Mumbai, MH, India" — whatever parts the IP lookup resolved, or "—". */
export function place(location: AdminLocation | null | undefined): string {
  if (!location) return '—';
  return [location.city, location.region, countryName(location.country)].filter(Boolean).join(', ');
}

/**
 * Estimated P&L in `target`'s major units: every currency's revenue converted
 * at `usdInr`, minus AI cost (recorded in USD). With no rate, only a result
 * that needs no conversion is returned; anything else is null, never a guess.
 */
export function pnlIn(
  revenue: MoneyByCurrency,
  costUsd: number | null,
  usdInr: number | null,
  target: 'INR' | 'USD',
): number | null {
  if (costUsd === null) return null;
  /** One major-unit amount of `from` in `target`, or null when it needs a rate we lack. */
  const convert = (amount: number, from: string): number | null => {
    if (from === target) return amount;
    if (!usdInr) return null;
    if (from === 'USD' && target === 'INR') return amount * usdInr;
    if (from === 'INR' && target === 'USD') return amount / usdInr;
    return null;
  };
  let total = convert(-costUsd, 'USD');
  for (const [currency, minor] of Object.entries(revenue)) {
    const part = convert(minor / 100, currency);
    if (total === null || part === null) return null;
    total += part;
  }
  return total;
}

/** A major-unit amount of `currency`, e.g. pnl figures. */
export function major(value: number | null, currency: 'INR' | 'USD'): string {
  if (value === null) return '—';
  return money(Math.round(value * 100), currency);
}

/** The P&L card's footnote: which rate converted it, or why it couldn't. */
export function fxNote(fx: AdminFx): string {
  if (!fx.usdInr) return 'No USD→INR rate available';
  const rate = `$1 = ₹${fx.usdInr.toFixed(2)}`;
  return fx.source === 'ecb' && fx.asOf ? `${rate} · ECB ${fx.asOf}` : `${rate} · configured`;
}
