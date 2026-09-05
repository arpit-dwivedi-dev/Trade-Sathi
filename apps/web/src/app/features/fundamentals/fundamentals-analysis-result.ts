import { Component, computed, effect, input, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import type {
  FundamentalsAnalysisResult as FundamentalsResult,
  FundamentalsClaim,
  FundamentalsDataNote,
  FundamentalsScenario,
  FundamentalsScenarioId,
} from '@chartanalyzer/shared';

import { FAILURE_COPY, GENERIC_FAILURE } from '../analyze/analysis-result';
import type { AnalysisRow } from '../analyze/analysis.types';

/** 'up'/'down' drive the same green/red the rest of the Fundamentals tab
 *  uses (see fund-figure-val[data-tone] and fund-quote[data-tone]); null
 *  leaves a reading neutral rather than forcing a colour onto it. */
type Tone = 'up' | 'down' | null;

/** One reading in the tile row at the top of the report. */
interface Tile {
  label: string;
  value: string;
  hint: string | null;
  tone: Tone;
}

/** The `{statement, tag, evidence}` shape most sections share, plus the one
 *  enum verdict that section carries — rendered generically rather than once
 *  per section, since the seven sections below differ only in that verdict. */
/** One row of the collapsed debug trace. */
interface DebugMetricRow {
  key: string;
  value: string;
  period: string;
  reliability: string;
}

interface TaggedSectionView {
  title: string;
  statement: string;
  verdictValue: string;
}

const SCENARIO_ORDER: FundamentalsScenarioId[] = ['bull', 'base', 'bear'];

/**
 * Renders one fundamentals AI analysis: the executive verdict, the section
 * verdicts (profitability, balance sheet, valuation, and so on), the
 * bull/base/bear scenarios, and the positive-signal/red-flag/missing-
 * information lists — the report `analyses.fundamentals_result` produced.
 *
 * Deliberately styled as one more section of the Fundamentals tab rather than
 * as its own "report" page: it sits directly below the identity card and the
 * raw-data cards (Valuation & ratios, Profitability & returns, ...) below it,
 * so it reuses their exact primitives (.fund-card, .hd, .lbl, .meta, .tiles,
 * .fund-figures) instead of the chart AnalysisResult component's own
 * editorial layout, which belongs to a different screen with a different
 * visual language.
 */
@Component({
  selector: 'app-fundamentals-analysis-result',
  imports: [MatCardModule, MatChipsModule],
  templateUrl: './fundamentals-analysis-result.html',
  styleUrl: './fundamentals-analysis-result.css',
})
export class FundamentalsAnalysisResultComponent {
  readonly row = input.required<AnalysisRow>();

  protected readonly failed = computed(() => this.row().status === 'failed');

  protected readonly failureMessage = computed(() => {
    const code = this.row().error_code;
    return (code && FAILURE_COPY[code]) || GENERIC_FAILURE;
  });

  protected readonly result = computed<FundamentalsResult | null>(
    () => this.row().fundamentals_result,
  );

  /* ── verdict / tone ──────────────────────────────────────────────────── */

  protected readonly stance = computed(() => this.result()?.executive_verdict.stance ?? null);

  protected readonly stanceTone = computed<Tone>(() => {
    switch (this.stance()) {
      case 'attractive':
        return 'up';
      case 'not_attractive':
        return 'down';
      default:
        return null;
    }
  });

  protected scenarioTone(id: FundamentalsScenarioId): Tone {
    if (id === 'bull') return 'up';
    if (id === 'bear') return 'down';
    return null;
  }

  /* ── tiles ───────────────────────────────────────────────────────────── */

  protected readonly tiles = computed<Tile[]>(() => {
    const result = this.result();
    if (!result) return [];
    return [
      {
        label: 'Stance',
        value: this.humanise(result.executive_verdict.stance),
        hint: null,
        tone: this.stanceTone(),
      },
      {
        label: 'Confidence',
        value: this.humanise(result.meta.confidence),
        hint: `${result.meta.completeness}/8 checklist items`,
        tone: result.meta.confidence === 'high' ? 'up' : result.meta.confidence === 'low' ? 'down' : null,
      },
      {
        label: 'Valuation',
        value: this.humanise(result.valuation.read),
        hint: null,
        tone:
          result.valuation.read === 'supported'
            ? 'up'
            : result.valuation.read === 'stretched'
              ? 'down'
              : null,
      },
      {
        label: 'Leverage',
        value: this.humanise(result.balance_sheet.leverage),
        hint: null,
        tone:
          result.balance_sheet.leverage === 'zero' || result.balance_sheet.leverage === 'low'
            ? 'up'
            : result.balance_sheet.leverage === 'high'
              ? 'down'
              : null,
      },
    ];
  });

  /**
   * Everything that qualifies the read, gathered above the sections the same
   * way the caveats banner leads the chart report — a reader who meets
   * "material conflict in the source data" after the verdicts has already
   * read them as settled.
   */
  protected readonly caveats = computed<string[]>(() => {
    const result = this.result();
    if (!result) return [];
    const lines = [...result.meta.data_issues, ...result.meta.notes];
    if (result.meta.material_conflict) {
      lines.unshift('The source data contains a conflict that caps how confident this read can be.');
    }
    return lines;
  });

  protected readonly showCaveats = computed(() => this.caveats().length > 0);

  /* ── data notes ─────────────────────────────────────────────────────────
     Written by the API's plausibility gate, not by the model: they are
     deterministic statements about the DATA (a stale price, a share count
     that moved with no corporate action to explain it), in plain English
     with no field paths and no raw floats. Distinct from `caveats` above,
     which is the model's own commentary on its reading. Absent on analyses
     stored before the derived pipeline landed, hence the empty default. */
  protected readonly dataNotes = computed<FundamentalsDataNote[]>(
    () => this.result()?.data_notes ?? [],
  );

  /* ── debug trace ────────────────────────────────────────────────────────
     The machine-readable trace behind the notes: which plausibility rules
     fired, which quarters the trailing windows were built from, and every
     derived metric with its period, basis and reliability. Collapsed by
     default — it is for working out why a number reads the way it does, not
     for the ordinary reader. */
  protected readonly debugOpen = signal(false);

  protected readonly debugTrace = computed(() => this.result()?.debug ?? null);

  protected toggleDebug(): void {
    this.debugOpen.update((open) => !open);
  }

  /** The metric rows, sorted so anything not fully reliable surfaces first. */
  protected readonly debugMetrics = computed<DebugMetricRow[]>(() => {
    const metrics = this.debugTrace()?.metrics;
    if (!metrics) return [];
    const rank = { unreliable: 0, missing: 1, ok: 2 } as const;
    return Object.entries(metrics)
      .map(([key, raw]) => {
        const m = raw as { value: number | null; period: string; reliability: string };
        return {
          key,
          value: m.value === null ? '—' : String(Number(m.value.toPrecision(6))),
          period: m.period,
          reliability: m.reliability,
        };
      })
      .sort(
        (a, b) =>
          (rank[a.reliability as keyof typeof rank] ?? 3) -
            (rank[b.reliability as keyof typeof rank] ?? 3) || a.key.localeCompare(b.key),
      );
  });

  /* ── the generically-rendered tagged sections ───────────────────────────
     Seven sections share the exact {statement, tag, evidence} + one enum
     verdict shape; rendering them from one list avoids seven near-identical
     template blocks. business/performance/historical_trend do not fit this
     shape (no verdict, two statements, or extra fields respectively) and are
     rendered in their own template blocks instead. */
  protected readonly sections = computed<TaggedSectionView[]>(() => {
    const r = this.result();
    if (!r) return [];
    return [
      { title: 'Profitability', statement: r.profitability.statement, verdictValue: this.humanise(r.profitability.direction) },
      { title: 'Per-share', statement: r.per_share.statement, verdictValue: this.humanise(r.per_share.dilution) },
      { title: 'Balance sheet', statement: r.balance_sheet.statement, verdictValue: this.humanise(r.balance_sheet.leverage) },
      { title: 'Cash flow', statement: r.cash_flow.statement, verdictValue: this.humanise(r.cash_flow.assessable) },
      { title: 'Capital efficiency', statement: r.capital_efficiency.statement, verdictValue: this.humanise(r.capital_efficiency.assessable) },
      { title: 'Dividend', statement: r.dividend.statement, verdictValue: this.humanise(r.dividend.sustainability) },
      { title: 'Valuation', statement: r.valuation.statement, verdictValue: this.humanise(r.valuation.read) },
    ];
  });

  /* ── scenarios ───────────────────────────────────────────────────────── */

  /** Always bull, base, bear, regardless of the order the model emitted them in. */
  protected readonly scenarios = computed<FundamentalsScenario[]>(() => {
    const byId = new Map((this.result()?.scenarios ?? []).map((s) => [s.id, s] as const));
    return SCENARIO_ORDER.map((id) => byId.get(id)).filter((s): s is FundamentalsScenario => !!s);
  });

  /* ── claim lists ─────────────────────────────────────────────────────── */

  protected readonly positiveSignals = computed<FundamentalsClaim[]>(
    () => this.result()?.positive_signals ?? [],
  );
  protected readonly redFlags = computed<FundamentalsClaim[]>(() => this.result()?.red_flags ?? []);

  /* ── shared helpers ──────────────────────────────────────────────────── */

  /** A code like `not_attractive` as words. */
  protected humanise(code: string): string {
    return code.replace(/_/g, ' ');
  }

  constructor() {
    // Keeps the raw provider text reachable while debugging without ever
    // putting it on screen — same console.warn channel the chart report uses.
    effect(() => {
      const row = this.row();
      if (row.status !== 'failed') return;
      console.warn('fundamentals analysis failed', {
        id: row.id,
        code: row.error_code,
        message: row.error_message,
      });
    });
  }
}
