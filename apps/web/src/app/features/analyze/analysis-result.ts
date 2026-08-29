import { DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import type { AnalysisPattern, AnalysisRow } from './analysis.types';

/**
 * Renders a finished analysis. Pure presentation — no API calls, no polling.
 */
@Component({
  selector: 'app-analysis-result',
  imports: [DecimalPipe],
  templateUrl: './analysis-result.html',
  styleUrl: './analysis-result.css',
})
export class AnalysisResult {
  readonly row = input.required<AnalysisRow>();
  readonly patterns = input<AnalysisPattern[]>([]);

  protected readonly failed = computed(() => this.row().status === 'failed');
  protected readonly supports = computed(() => this.row().support_levels ?? []);
  protected readonly resistances = computed(() => this.row().resistance_levels ?? []);
}
