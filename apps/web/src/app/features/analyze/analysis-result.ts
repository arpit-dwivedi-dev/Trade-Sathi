import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, effect, input } from '@angular/core';

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
};

/**
 * Renders a finished analysis. Pure presentation — no API calls, no polling.
 */
@Component({
  selector: 'app-analysis-result',
  imports: [DatePipe, DecimalPipe],
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
