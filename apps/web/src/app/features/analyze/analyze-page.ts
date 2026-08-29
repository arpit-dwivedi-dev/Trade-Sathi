import { Component, OnDestroy, inject, signal } from '@angular/core';

import { AnalysisResult } from './analysis-result';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';
import { AnalyzeService, type PollHandle } from './analyze.service';
import { ChartDrop, type ChartFileSelection } from './chart-drop';

type AnalyzeState =
  'idle' | 'uploading' | 'processing' | 'complete' | 'failed' | 'timed_out' | 'poll_error';

/**
 * Owns the upload → poll → result state machine and wires the pieces together.
 */
@Component({
  selector: 'app-analyze-page',
  imports: [ChartDrop, AnalysisResult],
  templateUrl: './analyze-page.html',
})
export class AnalyzePage implements OnDestroy {
  private readonly analyze = inject(AnalyzeService);

  protected readonly state = signal<AnalyzeState>('idle');
  protected readonly row = signal<AnalysisRow | null>(null);
  protected readonly patterns = signal<AnalysisPattern[]>([]);
  /** Set only for a failed submission; otherwise the state carries the copy. */
  protected readonly error = signal<string | null>(null);

  private poll: PollHandle | null = null;

  protected async onFileSelected(selection: ChartFileSelection): Promise<void> {
    // Belt and braces: chart-drop is already given disabled=true off-idle.
    if (this.state() !== 'idle') return;

    this.state.set('uploading');
    this.error.set(null);
    this.row.set(null);
    this.patterns.set([]);

    let blob: Blob;
    try {
      blob = await this.analyze.compressImage(selection.file);
    } catch {
      this.error.set('That image could not be read. Try a different screenshot.');
      this.state.set('failed');
      return;
    }

    const submitted = await this.analyze.submitAnalysis(blob, selection.sourceType);
    if (!submitted.ok) {
      // quota_exceeded is an expected, common outcome rather than a bug state,
      // so it keeps its own friendly copy from the service.
      this.error.set(submitted.message);
      this.state.set('failed');
      return;
    }

    this.state.set('processing');
    this.startPolling(submitted.id);
  }

  private startPolling(id: string): void {
    const handle = this.analyze.pollAnalysis(id, (row) => this.row.set(row));
    this.poll = handle;

    void handle.result.then((outcome) => {
      this.poll = null;

      switch (outcome.outcome) {
        case 'complete':
          this.row.set(outcome.row);
          this.patterns.set(outcome.patterns);
          this.state.set('complete');
          break;
        case 'failed':
          this.row.set(outcome.row);
          this.state.set('failed');
          break;
        case 'timed_out':
          this.state.set('timed_out');
          break;
        case 'poll_error':
          this.state.set('poll_error');
          break;
      }
    });
  }

  protected reset(): void {
    this.poll?.cancel();
    this.poll = null;
    this.row.set(null);
    this.patterns.set([]);
    this.error.set(null);
    this.state.set('idle');
  }

  ngOnDestroy(): void {
    // Without this the setInterval keeps firing after the user navigates away,
    // and would try to update a destroyed component's state.
    this.poll?.cancel();
    this.poll = null;
  }
}
