import type {
  DataNote,
  DerivedMetricKey,
  DerivedMetrics,
  PlausibilityFinding,
  ReportingProfile,
} from "@chartanalyzer/shared";
import type { RawStatements } from "../../lib/market-data/statements.js";

/**
 * The plausibility gate.
 *
 * A pure function. NO NETWORK. It marks fields 'unreliable'. It never
 * overwrites a value, never corrects one, and never searches for a better
 * one.
 *
 * The states are exactly: ok | unreliable | missing. There is deliberately no
 * 'corrected' state. The previous layer had one, and what it actually did was
 * take a quarterly-basis value that a web snippet happened to agree with and
 * stamp it "verified_match" — rubber-stamping the exact errors that broke the
 * report. Corroboration cannot resolve period or basis semantics, so the only
 * safe verdict this layer can reach is "this looks wrong, treat it with
 * caution".
 *
 * Each failure produces a plain-English note for the reader: no field paths,
 * no raw floats. We shipped `0.38509998` to a user.
 */

const CAPEX_TO_REVENUE_RANGE = [0, 0.4] as const;
const FCF_TO_OCF_RANGE = [-1.0, 1.05] as const;
const IMPLIED_TAX_RATE_RANGE = [0, 0.5] as const;
const DIVIDEND_YIELD_TOLERANCE = 0.05;
const SHARE_COUNT_YOY_LIMIT = 0.2;
const PE_CONSISTENCY_TOLERANCE = 0.05;

export interface PlausibilityInput {
  metrics: DerivedMetrics;
  statements: RawStatements;
  profile: ReportingProfile;
  /** Injected so the gate stays pure and testable. */
  now?: Date;
}

export interface PlausibilityOutput {
  /** The same metrics object, with reliability downgraded in place. */
  metrics: DerivedMetrics;
  dataNotes: DataNote[];
  findings: PlausibilityFinding[];
}

/**
 * Exchange holiday clusters make a flat "five calendar days" price-staleness
 * rule false-fire: an Indian market can be shut for the better part of a week
 * around Diwali without a single figure going stale. The rule is stated in
 * TRADING sessions and converted with a per-calendar allowance for the
 * longest normal closure.
 */
const MAX_CLOSURE_DAYS: Record<string, number> = {
  XNSE: 9,
  XBOM: 9,
  XNYS: 5,
};

export function runPlausibilityGate(input: PlausibilityInput): PlausibilityOutput {
  const { metrics, statements, profile } = input;
  const now = input.now ?? new Date();
  const findings: PlausibilityFinding[] = [];
  const notes: DataNote[] = [];

  /** Downgrades a metric to 'unreliable' and records both traces. */
  const flag = (
    key: DerivedMetricKey,
    rule: string,
    machineDetail: string,
    note: DataNote,
  ): void => {
    const metric = metrics[key];
    // 'missing' already says the value cannot be used; downgrading it to
    // 'unreliable' would be an upgrade in confidence, not a downgrade.
    if (metric.reliability === "missing") return;
    metric.reliability = "unreliable";
    findings.push({ metric: key, rule, detail: machineDetail });
    notes.push(note);
  };

  const value = (key: DerivedMetricKey): number | null => {
    const metric = metrics[key];
    return metric.reliability === "missing" ? null : metric.value;
  };

  // --- capex / revenue ---------------------------------------------------
  const capex = value("capex");
  const revenue = value("revenue");
  if (capex !== null && revenue !== null && revenue !== 0) {
    const ratio = capex / revenue;
    if (ratio < CAPEX_TO_REVENUE_RANGE[0] || ratio > CAPEX_TO_REVENUE_RANGE[1]) {
      flag("capex", "capex_over_revenue", `capex/revenue = ${ratio}`, {
        title: "Capital spending looks out of proportion",
        detail:
          "Reported capital expenditure is an unusually large or negative share of revenue for a full trading year, which usually means the figure includes something other than spending on plant and equipment. Cash-flow conclusions here are less dependable than the rest of the report.",
        severity: "caution",
      });
    }
  }

  // --- fcf / ocf ---------------------------------------------------------
  const fcf = value("fcf");
  const ocf = value("operatingCashFlow");
  if (fcf !== null && ocf !== null && ocf !== 0) {
    const ratio = fcf / ocf;
    if (ratio < FCF_TO_OCF_RANGE[0] || ratio > FCF_TO_OCF_RANGE[1]) {
      flag("fcf", "fcf_over_ocf", `fcf/ocf = ${ratio}`, {
        title: "Free cash flow does not sit sensibly against operating cash flow",
        detail:
          "Free cash flow should be operating cash flow less what the company spent on plant and equipment, so it cannot exceed operating cash flow or fall far below the negative of it. It does here, so treat the cash figures with caution.",
        severity: "caution",
      });
    }
  }

  // --- implied tax rate --------------------------------------------------
  const tax = value("impliedTaxRate");
  if (tax !== null && (tax < IMPLIED_TAX_RATE_RANGE[0] || tax > IMPLIED_TAX_RATE_RANGE[1])) {
    flag("impliedTaxRate", "implied_tax_rate", `implied tax rate = ${tax}`, {
      title: "The implied tax rate is outside a normal range",
      detail:
        "The gap between profit before tax and profit after tax implies a tax rate no ordinary company pays. That usually points to a one-off item, a restatement, or two figures drawn from different periods.",
      severity: "caution",
    });
  }

  // --- margin ordering ---------------------------------------------------
  const gross = value("grossMargin");
  const operating = value("operatingMargin");
  const net = value("netMargin");
  if (gross !== null && net !== null && net > gross) {
    flag("netMargin", "net_margin_above_gross", `netMargin ${net} > grossMargin ${gross}`, {
      title: "Net margin exceeds gross margin",
      detail:
        "Profit after every cost cannot be a larger share of revenue than profit after direct costs alone, unless income from outside the main business is being counted. The margin figures are not internally consistent.",
      severity: "caution",
    });
  }
  if (gross !== null && operating !== null && operating > gross) {
    flag("operatingMargin", "operating_margin_above_gross", `operatingMargin ${operating} > grossMargin ${gross}`, {
      title: "Operating margin exceeds gross margin",
      detail:
        "Operating profit cannot be a larger share of revenue than gross profit. The margin figures are not internally consistent.",
      severity: "caution",
    });
  }

  // --- quoted dividend yield vs declared dividend per share --------------
  // This checks the provider's own two market fields against each other: the
  // quoted yield applied to the quoted price must return the declared
  // dividend per share.
  //
  // It deliberately does NOT compare dividends PAID against dividends
  // DECLARED. Indian final dividends are declared after the year closes and
  // paid in the next one, so the cash basis systematically lags the declared
  // basis and a gap between them is expected. Flagging that gap as a conflict
  // is what produced the spurious confidence downgrade on both TCS and NVDA,
  // and both payout bases are published side by side precisely so a reader
  // can see the difference rather than have it treated as an error.
  const price = value("price");
  const dps = statements.spot.dividendDeclaredPerShare;
  const quotedYield = statements.spot.dividendYield;
  if (price !== null && dps !== null && dps !== 0 && quotedYield !== null) {
    const impliedDps = quotedYield * price;
    const drift = Math.abs(impliedDps - dps) / Math.abs(dps);
    if (drift > DIVIDEND_YIELD_TOLERANCE) {
      flag(
        "payoutRatioDeclared",
        "dividend_yield_vs_dps",
        `quoted yield x price = ${impliedDps} vs declared dps ${dps}`,
        {
          title: "The quoted dividend yield and the declared dividend disagree",
          detail:
            "Applying the quoted dividend yield to today's share price gives a different dividend per share than the one on record. The two are measured over different periods, so the payout figures are less dependable than the rest of the report.",
          severity: "caution",
        },
      );
    }
  }

  // --- share count year on year ------------------------------------------
  // Skipped outright on a bonus issue or a split: those multiply the share
  // count without diluting anyone, and firing here would report a routine
  // corporate action as a red flag. With NO feed at all the rule cannot be
  // skipped safely either, so the metric is marked unreliable rather than
  // passed as ok — "we could not check" is not "it is fine".
  const shareChange = shareCountYoy(statements);
  if (shareChange !== null && Math.abs(shareChange) > SHARE_COUNT_YOY_LIMIT) {
    if (statements.corporateActions === null) {
      flag("dilutedShares", "share_count_yoy_unverifiable", `share count moved ${shareChange}, no corporate-action feed`, {
        title: "The share count moved sharply and could not be explained",
        detail:
          "The number of shares changed by more than a fifth over the year. A bonus issue or a stock split would explain that harmlessly, but no corporate-action record was available to check, so per-share figures should be treated with caution.",
        severity: "caution",
      });
    } else if (!hasRestatingAction(statements)) {
      flag("dilutedShares", "share_count_yoy", `share count moved ${shareChange}`, {
        title: "The share count moved sharply",
        detail:
          "The number of shares changed by more than a fifth over the year with no split or bonus issue on record to explain it, so per-share figures may not be comparable across periods.",
        severity: "caution",
      });
    }
  }

  // --- trailing revenue vs the largest single quarter --------------------
  const largestQuarter = Math.max(
    0,
    ...statements.quarterly.map((q) => q.revenue ?? 0),
  );
  if (revenue !== null && largestQuarter > 0 && revenue < largestQuarter * 2) {
    flag("revenue", "ttm_revenue_too_small", `ttm ${revenue} < 2x largest quarter ${largestQuarter}`, {
      title: "The full-year revenue figure looks too small",
      detail:
        "Twelve months of revenue should comfortably exceed twice the largest single quarter. It does not here, which suggests a quarter is missing from the underlying filings.",
      severity: "caution",
    });
  }

  // --- price / earnings internal consistency -----------------------------
  const pe = value("trailingPe");
  const eps = value("trailingEps");
  if (pe !== null && eps !== null && price !== null && price !== 0) {
    const drift = Math.abs(pe * eps - price) / Math.abs(price);
    if (drift > PE_CONSISTENCY_TOLERANCE) {
      flag("trailingPe", "pe_consistency", `pe*eps ${pe * eps} vs price ${price}`, {
        title: "The valuation multiple does not match the price",
        detail:
          "Multiplying the earnings multiple by earnings per share should return today's share price. It does not, so the valuation figures are drawn from periods that do not line up.",
        severity: "caution",
      });
    }
  }

  // --- staleness (ported from the deterministic checks) ------------------
  const staleNote = priceStaleness(statements, profile, now);
  if (staleNote) {
    flag("price", "price_stale", staleNote.machine, staleNote.note);
  }

  const quarterNote = quarterStaleness(statements, now);
  if (quarterNote) {
    // The staleness is about the filings, not one metric — recorded against
    // the balance-sheet figures it most affects.
    for (const key of ["totalDebt", "totalCash", "equity", "netCash"] as DerivedMetricKey[]) {
      flag(key, "filings_stale", quarterNote.machine, quarterNote.note);
    }
  }

  // --- currency gate (ported) --------------------------------------------
  const { currency, financialCurrency } = statements.spot;
  if (currency !== null && financialCurrency !== null && currency !== financialCurrency) {
    notes.push({
      title: "Market and accounting figures are in different currencies",
      detail:
        "The share price is quoted in one currency and the financial statements are reported in another, so any figure combining the two has been withheld rather than estimated.",
      severity: "info",
    });
    findings.push({
      metric: "trailingPe",
      rule: "currency_gate",
      detail: `price currency ${currency} vs statement currency ${financialCurrency}`,
    });
  }

  return { metrics, dataNotes: dedupeNotes(notes), findings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Share count change across roughly one year, or null when uncheckable. */
function shareCountYoy(statements: RawStatements): number | null {
  const withShares = statements.quarterly.filter((q) => q.dilutedShares !== null);
  if (withShares.length < 5) return null;
  const latest = withShares[withShares.length - 1].dilutedShares as number;
  const yearAgo = withShares[withShares.length - 5].dilutedShares as number;
  if (yearAgo === 0) return null;
  return latest / yearAgo - 1;
}

/** True when a split or bonus in the window explains a share-count jump. */
function hasRestatingAction(statements: RawStatements): boolean {
  return (statements.corporateActions ?? []).some(
    (action) => action.kind === "split" || action.kind === "bonus",
  );
}

function priceStaleness(
  statements: RawStatements,
  profile: ReportingProfile,
  now: Date,
): { machine: string; note: DataNote } | null {
  const { asOf } = statements.spot;
  if (asOf === null) {
    return {
      machine: "price carries no timestamp",
      note: {
        title: "The price could not be dated",
        detail: "No timestamp came with the quoted price, so how current it is cannot be established.",
        severity: "caution",
      },
    };
  }
  const ageDays = (now.getTime() - Date.parse(asOf)) / 86_400_000;
  const allowance = MAX_CLOSURE_DAYS[profile.marketCalendar] ?? 5;
  if (ageDays <= allowance) return null;
  return {
    machine: `price is ${Math.round(ageDays)} days old against a ${allowance}-day allowance for ${profile.marketCalendar}`,
    note: {
      title: "The share price is out of date",
      detail:
        "The most recent quoted price is older than this exchange's longest normal closure, so valuation figures resting on it may not reflect where the shares trade now.",
      severity: "caution",
    },
  };
}

const FILINGS_STALE_DAYS = 183;

function quarterStaleness(
  statements: RawStatements,
  now: Date,
): { machine: string; note: DataNote } | null {
  const latest = statements.quarterly[statements.quarterly.length - 1];
  if (!latest) return null;
  const ageDays = (now.getTime() - Date.parse(`${latest.periodEnd}T00:00:00Z`)) / 86_400_000;
  if (ageDays <= FILINGS_STALE_DAYS) return null;
  return {
    machine: `most recent reported quarter ${latest.periodEnd} is ${Math.round(ageDays)} days old`,
    note: {
      title: "The latest available filings are more than six months old",
      detail:
        "No newer quarterly results were available, so the balance-sheet position described here may have moved since it was reported.",
      severity: "caution",
    },
  };
}

/** One note per distinct title — the same rule can fire on several metrics. */
function dedupeNotes(notes: DataNote[]): DataNote[] {
  const seen = new Set<string>();
  const out: DataNote[] = [];
  for (const note of notes) {
    if (seen.has(note.title)) continue;
    seen.add(note.title);
    out.push(note);
  }
  return out;
}
