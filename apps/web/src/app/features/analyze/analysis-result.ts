import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, effect, input } from '@angular/core';

import { ChartImage } from '../../shared/chart-image';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';

const GENERIC_FAILURE = "This analysis couldn't be completed. Try again.";

/**
 * error_code -> user-facing copy. error_message is provider/parser text and is
 * never shown: it leaks internals and reads as noise to a user.
 */
const FAILURE_COPY: Record<string, string> = {
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
 * Renders a finished analysis. Presentation only — the one exception is the
 * embedded chart image, which signs its own URL inside <app-chart-image>.
 */
@Component({
  selector: 'app-analysis-result',
  imports: [ChartImage, DatePipe, DecimalPipe],
  templateUrl: './analysis-result.html',
  styleUrl: './analysis-result.css',
})
export class AnalysisResult {
  readonly row = input.required<AnalysisRow>();
  readonly patterns = input<AnalysisPattern[]>([]);

  protected readonly failed = computed(() => this.row().status === 'failed');

  /** Unrecognised (and absent) codes fall back to the generic line. */
  protected readonly failureMessage = computed(() => {
    const code = this.row().error_code;
    return (code && FAILURE_COPY[code]) || GENERIC_FAILURE;
  });

  protected readonly supports = computed(() => this.row().support_levels ?? []);
  protected readonly resistances = computed(() => this.row().resistance_levels ?? []);

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
   * describes a step that never happened.
   */
  protected readonly readFromImage = computed(() => this.row().source !== 'live');

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
