import { DatePipe, DecimalPipe, UpperCasePipe } from '@angular/common';
import { Component, computed, effect, input, output } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ChipModule } from 'primeng/chip';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import type { AnalysisResult as Analysis, AnalysisScenario } from '@chartanalyzer/shared';

import { ChartImage } from '../../shared/chart-image';
import { TimeframeLabelPipe } from '../../shared/timeframe-label.pipe';
import { AppIcon } from '../../shared/icons/app-icon';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';

/** Exported because fundamentals-analysis-result.ts (the Fundamentals tab's
 *  own report) shares this exact copy — both surfaces render the same
 *  analyses-row error_code/error_message pair the AI pipeline writes. */
export const GENERIC_FAILURE = "This analysis couldn't be completed. Try again.";

/**
 * error_code -> user-facing copy. error_message is provider/parser text and is
 * never shown: it leaks internals and reads as noise to a user.
 */
export const FAILURE_COPY: Record<string, string> = {
  api_error: "We couldn't reach the AI provider — try again in a moment.",
  invalid_json: 'The analysis came back in an unexpected format — try again, this is usually transient.',
  schema_validation:
    'The analysis came back in an unexpected format — try again, this is usually transient.',
  // Deliberately not "try again in a moment": a rate limit is often a daily
  // cap, and telling someone to retry immediately just wastes their time.
  rate_limited: 'The analysis service is temporarily over capacity. Please try again later.',
  provider_auth: 'The analysis service is unavailable right now. Please try again later.',
  market_data_unavailable:
    "We couldn't load market data for this instrument. Try again, or pick a different window.",
  chart_render_failed: "We couldn't draw the chart for this analysis. Please try again.",
};

/**
 * The reason codes both prompts emit, in the words a reader can act on.
 *
 * A code with no entry here falls back to the code with its underscores
 * removed, which is why an unrecognised one is survivable rather than a blank
 * caption — but every code in ANALYSIS_REASON_CODES should have a line.
 */
const REASON_COPY: Record<string, string> = {
  axis_unreadable: 'the price axis could not be read, so no level is priced',
  axis_partial: 'only part of the price axis was legible, so prices are approximate',
  too_few_candles: 'too few candles were visible to judge structure',
  no_volume_pane: 'the chart has no volume pane, so volume was not read',
  chart_type_unsupported:
    'this chart type is smoothed or synthetic, so its extremes are not traded prices',
  timeframe_unknown: 'the chart does not state its timeframe',
  symbol_unresolved: 'the symbol could not be matched to an instrument',
  no_history: 'there is not enough history behind this window',
  illiquid: 'the instrument looks too thinly traded to read reliably',
  not_a_chart: 'the image does not appear to be a price chart',
  heavy_annotation: 'drawings and annotations obscure the price action',
  price_mid_range: 'price sits too far from any level for a setup to be defined',
  signals_conflict: 'the signals on this chart point in opposite directions',
  expiry_imminent: 'expiry is close enough to dominate the price behaviour',
};

/** One reading in the tile row at the top of the report. */
interface Tile {
  label: string;
  value: string;
  /** Small dimmed line under the value, for the qualifier a number needs. */
  hint: string | null;
}

/**
 * Renders a finished analysis. Presentation only — the one exception is the
 * embedded chart image, which signs its own URL inside <app-chart-image>.
 *
 * TWO REPORTS, ONE COMPONENT
 *
 * A row analyzed by the current prompts carries `analysis_result`: the whole
 * structured read (setup formats, level zones, regime, a falsifier). A row
 * from before them carries the old flat reading in its own columns and no
 * payload. Both render, because the old rows are the user's history — see the
 * @else branch in the template. `analysis_result` being non-null is the test.
 */
@Component({
  selector: 'app-analysis-result',
  imports: [
    AppIcon,
    ButtonModule,
    CardModule,
    ChartImage,
    ChipModule,
    DatePipe,
    DecimalPipe,
    ProgressSpinnerModule,
    TimeframeLabelPipe,
    UpperCasePipe,
  ],
  templateUrl: './analysis-result.html',
  styleUrl: './analysis-result.css',
})
export class AnalysisResult {
  readonly row = input.required<AnalysisRow>();
  readonly patterns = input<AnalysisPattern[]>([]);
  readonly standalone = input(false);
  readonly downloadBusy = input(false);
  readonly downloadRequested = output<void>();

  protected readonly failed = computed(() => this.row().status === 'failed');

  /** Unrecognised (and absent) codes fall back to the generic line. */
  protected readonly failureMessage = computed(() => {
    const code = this.row().error_code;
    return (code && FAILURE_COPY[code]) || GENERIC_FAILURE;
  });

  /** The structured read, or null for a row analyzed before those prompts. */
  protected readonly result = computed<Analysis | null>(() => this.row().analysis_result);

  /* ── the structured report ───────────────────────────────────────────── */

  protected readonly zones = computed(() => this.result()?.structure.levels ?? []);
  protected readonly scenarios = computed(() => this.result()?.setup.scenarios ?? []);

  /**
   * Everything that qualifies the read, gathered into one banner rather than
   * scattered through the report.
   *
   * A caveat the reader meets after the numbers has already done its damage:
   * they have read a price band as exact. So a degraded axis, a blocker, a
   * suspected corporate action and the model's own free-text notes all surface
   * above the readings, or not at all.
   */
  protected readonly caveats = computed<string[]>(() => {
    const result = this.result();
    if (!result) return [];

    const lines = result.meta.blockers.map((code) => REASON_COPY[code] ?? this.humanise(code));
    if (result.meta.corporate_action_suspected) {
      lines.push('a price gap consistent with a split or bonus sits in this window');
    }
    lines.push(...result.meta.notes);
    return lines;
  });

  /**
   * Whether the read itself is degraded, independent of any caveat text.
   * A partial axis with no blocker listed is still a partial axis.
   */
  protected readonly axisDegraded = computed(
    () => (this.result()?.meta.axis_state ?? 'calibrated') !== 'calibrated',
  );

  protected readonly showCaveats = computed(
    () => this.axisDegraded() || this.caveats().length > 0,
  );

  /**
   * The four readings that lead the report.
   *
   * Deliberately not the old trend/volatility/volume/sentiment row: the
   * current prompts emit no sentiment at all, and "volatility: high" as a
   * word says less than the ATR percentage it was standing in for.
   */
  protected readonly tiles = computed<Tile[]>(() => {
    const result = this.result();
    if (!result) return [];

    const { structure, regime, setup } = result;
    return [
      {
        label: 'Setup',
        value: setup.format === 'none' ? 'no setup' : this.humanise(setup.format),
        hint:
          setup.format === 'none' && setup.abstain_reason
            ? this.humanise(setup.abstain_reason)
            : null,
      },
      {
        label: 'Structure',
        value: structure.state ?? '—',
        hint: `${structure.clarity} clarity`,
      },
      {
        label: 'ATR',
        value: regime.atr_pct !== null ? `${regime.atr_pct}%` : '—',
        hint:
          regime.atr_percentile !== null
            ? `${Math.round(regime.atr_percentile * 100)}th pct of window`
            : 'of price',
      },
      {
        label: 'Volume',
        value: regime.volume_vs_median !== null ? `${regime.volume_vs_median}×` : '—',
        hint: regime.volume_vs_median !== null ? 'vs window median' : 'not read',
      },
    ];
  });

  /** True only when the model counted enough analogues for a base rate to mean anything. */
  protected readonly hasBaseRate = computed(() => {
    const rate = this.result()?.base_rate;
    return !!rate && rate.n_analogues !== null && rate.hit_rate !== null;
  });

  /* ── the legacy report ───────────────────────────────────────────────── */

  protected readonly supports = computed(() => this.row().support_levels ?? []);
  protected readonly resistances = computed(() => this.row().resistance_levels ?? []);

  /* ── shared ──────────────────────────────────────────────────────────── */

  /** instrument_type from the current prompts, asset_class from the old ones. */
  protected readonly assetLabel = computed(
    () => this.row().instrument_type ?? this.row().asset_class,
  );

  /**
   * Where this analysis came from, in the user's terms.
   *
   * Generated analyses (the live view, the daily briefing) store source_type
   * 'upload' purely to satisfy that column's NOT NULL constraint — `source` is
   * their real provenance. Reading source_type straight through labelled every
   * live analysis "upload", which is the one thing it certainly was not.
   */
  protected readonly sourceLabel = computed(() => {
    const row = this.row();
    switch (row.source) {
      case 'live':
        return 'live chart';
      case 'watchlist_daily':
        return 'daily briefing';
      default:
        return row.source_type;
    }
  });

  /**
   * Whether the model actually read the stored image.
   *
   * A live analysis is made from the exact OHLCV series, not from a picture of
   * it — the image is rendered and kept only so the user can see the chart
   * behind the result. Claiming the symbol was "detected from image" there
   * describes a step that never happened. The payload states this outright
   * (`kind`); the `source` check is the fallback for rows without one.
   */
  protected readonly readFromImage = computed(() => {
    const result = this.result();
    return result ? result.kind === 'vision' : this.row().source !== 'live';
  });

  /** A code like `price_mid_range` as words. */
  protected humanise(code: string): string {
    return code.replace(/_/g, ' ');
  }

  /**
   * A price ZONE, which is what the prompts emit — never a point. A band whose
   * edges coincide prints as one number rather than "1402 – 1402".
   */
  protected band(low: number, high: number): string {
    const format = (value: number): string =>
      value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return low === high ? format(low) : `${format(low)} – ${format(high)}`;
  }

  /** The scenario heading: what has to happen before the geometry is live. */
  protected triggerLabel(scenario: AnalysisScenario): string {
    return scenario.trigger === 'already_triggered'
      ? 'already triggered'
      : `on a ${this.humanise(scenario.trigger)}`;
  }

  constructor() {
    // Keeps the raw provider text reachable while debugging without ever
    // putting it on screen. Same console.warn channel the rest of the app uses.
    effect(() => {
      const row = this.row();
      if (row.status !== 'failed') return;
      console.warn('analysis failed', {
        id: row.id,
        code: row.error_code,
        message: row.error_message,
      });
    });
  }
}
