import type { ReportingBasis } from "@tradesathi/shared";
import {
  applyPeriodIdentities,
  quartersOfFiscalYear,
  reconstructMissingQuarters,
} from "./statement-reconstruction.js";
import type { RawPeriod, RawStatements, StatementSource } from "./statements.js";

/**
 * Combines RawStatements from multiple sources, priority-ordered — index 0
 * wins.
 *
 * Every period is taken WHOLESALE from one source: the winning source's
 * figures are never overwritten, and no two sources' values for the same line
 * are ever blended. What a lower-priority source may do, and only once proved
 * to be reporting the same series (see provesSameSeries), is COMPLETE a
 * period with lines the winner does not report at all. That distinction is
 * the whole design. An official-filing source is authoritative on what it
 * files and silent on the rest: NSE's quarterly regulatory filing carries a
 * P&L and nothing else, so a wholesale-only merge answers "what is Reliance's
 * equity, cash, debt, share count, operating cash flow?" with "unknown" for
 * every Indian company — not because nobody reports it, but because the
 * source that outranked the vendor never claimed to.
 *
 * `quarterly` and `annual` are deduplicated independently, matched by
 * `periodEnd` WITHIN TOLERANCE, not exact string equality. Verified against
 * live data: SEC EDGAR reports NVDA's actual 52/53-week fiscal quarter end
 * (e.g. "2025-04-27") while Yahoo's own quarterly history normalises the same
 * real quarter to calendar month-end (e.g. "2025-04-30") — a 3-day vendor
 * discrepancy, not a different quarter. An exact-match dedup would let both
 * survive as separate periods a few days apart, which breaks the 80-100-day
 * contiguity window derive-metrics.ts uses to build a TTM. Tolerance is set
 * well below that 80-day floor, so it can never fold two genuinely
 * consecutive quarters (or fiscal years) into one.
 *
 * `spot`/`forward`/`corporateActions` come from the first source whose spot
 * carries a price — in practice always Yahoo's, since neither official-filing
 * adapter populates a live quote.
 */
export function mergeStatementSources(sources: RawStatements[]): RawStatements {
  if (sources.length === 0) {
    throw new Error("mergeStatementSources requires at least one source");
  }

  const sameSeries = provenSameSeries(sources);
  const aligned = adoptProvenBasis(sources, sameSeries);

  const resolved = resolveUnstatedBasis(
    complete(dedupePeriods(aligned.map((s) => s.quarterly)), aligned, sameSeries),
    complete(dedupePeriods(aligned.map((s) => s.annual)), aligned, sameSeries),
  );

  const withSpot = sources.find((s) => s.spot.price !== null) ?? sources[0];
  const withForward = sources.find((s) => s.forward.length > 0) ?? sources[0];
  const withCorporateActions = sources.find((s) => s.corporateActions !== null) ?? sources[0];

  const annual = applyPeriodIdentities(resolved.annual);

  return {
    // Both applied last, over the whole merged series. A fiscal year can be
    // complete here and incomplete in every individual source, which is
    // exactly the gap a per-source pass cannot close; and an identity can
    // only be applied once the line it needs has arrived from wherever it
    // came from. Identities first, so a filled subtotal is available to the
    // reconstruction, and reconstruction strictly within one basis.
    quarterly: reconstructMissingQuarters(applyPeriodIdentities(resolved.quarterly), annual),
    annual,
    spot: withSpot.spot,
    forward: withForward.forward,
    corporateActions: withCorporateActions.corporateActions,
  };
}

/**
 * Two periods within this many days of each other, of the same cadence, are
 * treated as the same real-world period.
 *
 * Sized against the worst case the vendor's month-end rounding can produce,
 * not the typical one. A 52/53-week filer's quarter can end in the first days
 * of a month — Costco's third quarter of fiscal 2026 ended on 10 May, which
 * Yahoo publishes as 31 May — so the gap between two records of ONE quarter
 * runs to the length of a month, not the three days NVDA's calendar happens
 * to produce. At twenty days Costco kept both, four days over the line, and
 * the duplicate broke the contiguity every trailing metric needs.
 *
 * Still far below the 80-day floor derive-metrics.ts treats as "the next
 * quarter", so it can never merge two genuinely distinct consecutive periods.
 */
const SAME_PERIOD_TOLERANCE_DAYS = 45;

function daysApart(a: string, b: string): number {
  return Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000);
}

/** Reconciles to within a rounding step of the audited figure. */
const RECONCILIATION_TOLERANCE = 0.005;

function agrees(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  return Math.abs(a - b) / scale <= RECONCILIATION_TOLERANCE;
}

function periodsOf(source: RawStatements): RawPeriod[] {
  return [...source.quarterly, ...source.annual];
}

/**
 * The basis a source reports under, where it says — the most common one, not
 * merely the first seen. A single source's history can legitimately mix: an
 * Indian company that filed only standalone results for one quarter leaves
 * that one quarter standalone in an otherwise consolidated series, and the
 * odd quarter must not be mistaken for what the source reports generally.
 */
function statedBasisOf(source: RawStatements): ReportingBasis | null {
  const counts = new Map<ReportingBasis, number>();
  for (const period of periodsOf(source)) {
    if (period.basis === "unknown") continue;
    counts.set(period.basis, (counts.get(period.basis) ?? 0) + 1);
  }
  let best: ReportingBasis | null = null;
  let bestCount = 0;
  for (const [basis, count] of counts) {
    if (count > bestCount) {
      best = basis;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Lines usable to prove two sources describe the same series, best first.
 *
 * Net income leads because it is the least definitionally ambiguous figure in
 * any accounting framework — profit attributable to owners means one thing.
 * Revenue does not: a bank files interest earned where a manufacturer files
 * revenue from operations, filers differ on gross versus net of excise, and
 * Yahoo's revenue line for an Indian bank was verified live to be neither of
 * the two figures the bank itself files. Leading on revenue would refuse the
 * proof for exactly the companies that most need it.
 */
const PROOF_LINES = ["netIncome", "revenue"] as const;

/** Below this many agreeing periods a match is coincidence, not proof. */
const MIN_PROOF_PERIODS = 2;

/**
 * How far apart a lower-priority source's figure may be from the winner's and
 * still be worth reading OTHER lines from that record.
 *
 * Deliberately far coarser than RECONCILIATION_TOLERANCE, because the two
 * tolerances answer different questions. That one asks "is this the same
 * audited number?" and belongs at a rounding step. This one asks "is this
 * record grossly wrong?" and has to tolerate definitional drift that is not
 * an error at all: HDFC Bank's own filings tag minority interest as zero in
 * some quarters and not others, leaving the filer's attributable profit and
 * Yahoo's about 5% apart with neither being wrong. Refusing at 0.5% there
 * cost the bank its equity, share count, debt and cash — none of which is a
 * profit figure — over a disagreement about minority interest.
 *
 * It still refuses what it exists to refuse: Yahoo reports Reliance's
 * September 2025 profit as 91.3B against the 181.7B the company filed, and a
 * record wrong by half has no claim to be right about the balance sheet.
 */
const DONOR_SANITY_TOLERANCE = 0.25;

/**
 * The gap between two records of the same period on the first line comparable
 * across sources, as a fraction — or null when neither reports a line the
 * other does, so nothing can be said either way.
 */
function periodGap(a: RawPeriod, b: RawPeriod): number | null {
  const line = PROOF_LINES.find((l) => a[l] !== null && b[l] !== null);
  if (!line) return null;
  const x = a[line] as number;
  const y = b[line] as number;
  const scale = Math.max(Math.abs(x), Math.abs(y));
  return scale === 0 ? 0 : Math.abs(x - y) / scale;
}

/**
 * The sources proved to report the same series as the highest-priority source
 * that states a basis at all.
 *
 * WHY A PROOF AND NOT AN ASSUMPTION
 *
 * Yahoo states no accounting basis anywhere, and yahoo-statements.ts is right
 * not to invent one — an unknown basis is recorded as unknown. But an unknown
 * basis is not free: derive-metrics.ts refuses any window that mixes bases, so
 * a single Yahoo quarter at the recent end of an otherwise official series
 * makes every trailing metric unreportable. Confirmed live on Coca-Cola, where
 * one vendor-supplied quarter behind seventy-two SEC EDGAR ones cost nineteen
 * of thirty metrics.
 *
 * So the two series are TESTED against each other rather than assumed about.
 * Where both sources report the same period, their figures must match: two
 * sources reporting the same company on the same basis publish the same
 * numbers, and two reporting it on different bases do not — a consolidated
 * total and a parent-only one are not close. Verified live on Coca-Cola,
 * whose four overlapping quarters agree with SEC EDGAR to the dollar.
 *
 * WHY AGREEMENT COUNTS AND DISAGREEMENT DOES NOT
 *
 * The test is for matches, not for the absence of mismatches. Two independent
 * sources landing on the same quarterly profit to within a rounding step, in
 * two different quarters, is not something a consolidated series and a
 * parent-only one do — those differ in every period, by the whole
 * contribution of the subsidiaries. So a pair of exact matches settles the
 * question on its own.
 *
 * A later disagreement does not unsettle it. Verified live: Yahoo has one bad
 * quarter for Reliance and a persistent ~5% gap on HDFC Bank that traces to
 * the bank's own inconsistent minority-interest tagging. Neither is evidence
 * of a different basis, and treating them as a veto cost both companies most
 * of their metrics. Reliability of an INDIVIDUAL record is a separate
 * question, asked separately, at the point one is actually read from — see
 * completableDonor.
 *
 * A source that fails the test keeps its unknown basis and completes nothing,
 * which is exactly the behaviour that predates this function — a failed proof
 * can only ever leave things as they were.
 */
function provenSameSeries(sources: RawStatements[]): Set<StatementSource> {
  const proven = new Set<StatementSource>();
  const reference = sources.find((s) => statedBasisOf(s) !== null);
  if (!reference) return proven;

  const referenceBasis = statedBasisOf(reference);
  proven.add(reference.quarterly[0]?.source ?? reference.annual[0]?.source ?? "yahoo");
  const referencePeriods = periodsOf(reference).filter((p) => p.basis === referenceBasis);

  for (const candidate of sources) {
    if (candidate === reference) continue;

    let agreed = 0;
    for (const period of periodsOf(candidate)) {
      const match = referencePeriods.find(
        (r) =>
          r.months === period.months &&
          r.currency === period.currency &&
          daysApart(r.periodEnd, period.periodEnd) <= SAME_PERIOD_TOLERANCE_DAYS,
      );
      if (!match) continue;

      const gap = periodGap(period, match);
      if (gap !== null && gap <= RECONCILIATION_TOLERANCE) agreed += 1;
    }

    if (agreed >= MIN_PROOF_PERIODS) {
      for (const period of periodsOf(candidate)) proven.add(period.source);
    }
  }

  return proven;
}

/**
 * Relabels a proven source's unstated periods with the basis it was proved
 * against. Never overrides a basis a source actually stated, and applies to
 * the whole of that source's series, since one source publishes one series
 * for one instrument.
 */
function adoptProvenBasis(
  sources: RawStatements[],
  sameSeries: Set<StatementSource>,
): RawStatements[] {
  const reference = sources.find((s) => statedBasisOf(s) !== null);
  const referenceBasis = reference ? statedBasisOf(reference) : null;
  if (referenceBasis === null) return sources;

  const relabel = (periods: RawPeriod[]): RawPeriod[] =>
    periods.map((period) =>
      period.basis === "unknown" && sameSeries.has(period.source)
        ? { ...period, basis: referenceBasis }
        : period,
    );

  return sources.map((source) => ({
    ...source,
    quarterly: relabel(source.quarterly),
    annual: relabel(source.annual),
  }));
}

/**
 * Statement lines a lower-priority source may supply for a period a
 * higher-priority one won.
 *
 * The revenue triple is deliberately absent. Revenue, total income and other
 * income must stay internally consistent (the plausibility gate checks that
 * revenue + other income equals total income), and a triple assembled from
 * two vendors' different revenue definitions would fail that check for a
 * reason that has nothing to do with the filer. Every line here is instead
 * one a source either files or does not.
 */
const COMPLETABLE_LINES = [
  "costOfRevenue",
  "grossProfit",
  "operatingIncome",
  "pretaxIncome",
  "netIncome",
  "dilutedShares",
  "operatingCashFlow",
  "capex",
  "dividendsPaid",
  "equity",
  "totalDebt",
  "cash",
  "sharesOutstanding",
] as const;

/**
 * Whether `donor` may supply lines for the period `winner` won.
 *
 * The series-level proof is necessary but not sufficient. It establishes that
 * a source reports the same series; it says nothing about whether any one of
 * its records is sound, and a proven source still ships bad periods. So each
 * donor record is checked on its own before anything is read from it: one
 * grossly at odds with the filing it would complete is refused outright
 * rather than mined for its other lines, because a record wrong about profit
 * by half has no claim to be right about equity.
 */
function completableDonor(
  donor: RawPeriod,
  winner: RawPeriod,
  sameSeries: Set<StatementSource>,
): boolean {
  if (donor.source === winner.source) return false;
  if (!sameSeries.has(donor.source)) return false;
  if (donor.months !== winner.months) return false;
  if (donor.currency !== winner.currency) return false;
  if (daysApart(donor.periodEnd, winner.periodEnd) > SAME_PERIOD_TOLERANCE_DAYS) return false;
  const gap = periodGap(donor, winner);
  return gap === null || gap <= DONOR_SANITY_TOLERANCE;
}

/**
 * Fills lines the winning source does not report from a proven-equivalent
 * one, in priority order. Only ever writes where the winner holds null.
 */
function complete(
  chosen: RawPeriod[],
  sources: RawStatements[],
  sameSeries: Set<StatementSource>,
): RawPeriod[] {
  return chosen.map((period) => {
    let filled = period;
    const donors = new Set<StatementSource>();

    for (const source of sources) {
      const candidates = period.months === 12 ? source.annual : source.quarterly;
      const donor = candidates.find((d) => completableDonor(d, period, sameSeries));
      if (!donor) continue;

      for (const line of COMPLETABLE_LINES) {
        if (filled[line] !== null || donor[line] === null) continue;
        filled = { ...filled, [line]: donor[line] };
        donors.add(donor.source);
      }
    }

    return donors.size === 0 ? filled : { ...filled, completedFrom: [...donors] };
  });
}

/**
 * Adopts a PROVEN reporting basis for periods whose source never stated one,
 * where no period-level overlap exists to prove it with.
 *
 * The fallback to provenSameSeries above, for the case where the two sources'
 * histories meet end to end instead of overlapping. If a fiscal year's four
 * quarters, drawn partly from the filings and partly from the vendor, sum to
 * that year's audited revenue, the vendor is reporting the SAME series on the
 * same basis. Anything else would not add up.
 *
 * Confirmed against live TCS: NSE's consolidated Jun/Sep/Dec quarters plus
 * Yahoo's March quarter total 2,553.2B, exactly the audited FY2025 revenue.
 *
 * The relabel only ever moves a period from 'unknown' to a basis proved by
 * arithmetic, never overrides a basis a source actually stated, and applies
 * to the whole of that source's series.
 */
function resolveUnstatedBasis(
  quarterly: RawPeriod[],
  annual: RawPeriod[],
): { quarterly: RawPeriod[]; annual: RawPeriod[] } {
  const statedBasis = quarterly.find((q) => q.basis !== "unknown")?.basis;
  if (statedBasis === undefined) return { quarterly, annual };

  const unstatedSources = new Set(
    [...quarterly, ...annual].filter((p) => p.basis === "unknown").map((p) => p.source),
  );
  if (unstatedSources.size === 0) return { quarterly, annual };

  const proved = annual.some((year) => {
    if (year.revenue === null) return false;
    const parts = quartersOfFiscalYear(year.periodEnd, quarterly);
    if (parts.length !== 4 || parts.some((p) => p.revenue === null)) return false;
    // Only a year that actually SPANS the two conventions proves anything.
    if (!parts.some((p) => p.basis === statedBasis)) return false;
    if (!parts.some((p) => p.basis === "unknown")) return false;

    const summed = parts.reduce((total, p) => total + (p.revenue ?? 0), 0);
    return agrees(summed, year.revenue);
  });

  if (!proved) return { quarterly, annual };

  const relabel = (periods: RawPeriod[]): RawPeriod[] =>
    periods.map((period) =>
      period.basis === "unknown" && unstatedSources.has(period.source)
        ? { ...period, basis: statedBasis satisfies ReportingBasis }
        : period,
    );

  return { quarterly: relabel(quarterly), annual: relabel(annual) };
}

function dedupePeriods(perSourceLists: RawPeriod[][]): RawPeriod[] {
  const chosen: RawPeriod[] = [];
  for (const list of perSourceLists) {
    for (const period of list) {
      const alreadyCovered = chosen.some(
        (existing) =>
          existing.months === period.months &&
          daysApart(existing.periodEnd, period.periodEnd) <= SAME_PERIOD_TOLERANCE_DAYS,
      );
      if (!alreadyCovered) chosen.push(period);
    }
  }
  return chosen.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}
