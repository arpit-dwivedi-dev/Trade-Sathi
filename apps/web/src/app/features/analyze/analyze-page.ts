import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';

import { AnalysisResult } from './analysis-result';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';
import { AnalyzeService, type PollHandle, type QuotaStatus } from './analyze.service';
import { ChartDrop, type ChartFileSelection } from './chart-drop';
import { BuyCreditsButton } from '../billing/buy-credits-button';
import { UpgradeButton } from '../billing/upgrade-button';

type AnalyzeState =
  | 'idle'
  | 'uploading'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'quota_exceeded'
  | 'timed_out'
  | 'poll_error';

/**
 * Owns the upload → poll → result state machine and wires the pieces together.
 */
@Component({
  selector: 'app-analyze-page',
  imports: [ChartDrop, AnalysisResult, UpgradeButton, BuyCreditsButton],
  styleUrl: './analyze-page.css',
  templateUrl: './analyze-page.html',
})
export class AnalyzePage implements OnInit, OnDestroy {
  private readonly analyze = inject(AnalyzeService);

  protected readonly state = signal<AnalyzeState>('idle');
  protected readonly row = signal<AnalysisRow | null>(null);
  protected readonly patterns = signal<AnalysisPattern[]>([]);
  /** Set only for a failed submission; otherwise the state carries the copy. */
  protected readonly error = signal<string | null>(null);
  /**
   * This month's quota, read on load. null means "not known" (SSR, no session,
   * read error) — the upload path stays open in that case and the backend's 402
   * remains the authority.
   */
  protected readonly quota = signal<QuotaStatus | null>(null);

  private poll: PollHandle | null = null;

  ngOnInit(): void {
    void this.refreshQuota();
  }

  /** True only when the quota is known *and* used up. */
  protected quotaExhausted(): boolean {
    const quota = this.quota();
    return quota !== null && quota.remaining <= 0;
  }

  private async refreshQuota(): Promise<void> {
    this.quota.set(await this.analyze.fetchQuota());
  }

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
      // so it keeps its own friendly copy from the service and its own state —
      // that state is what offers the upgrade path instead of just an error.
      this.error.set(submitted.message);
      if (submitted.reason === 'quota_exceeded') {
        // The cached quota disagreed with the backend, which is authoritative.
        void this.refreshQuota();
        this.state.set('quota_exceeded');
      } else {
        this.state.set('failed');
      }
      return;
    }

    void this.refreshQuota();
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

  /**
   * The user upgraded from the quota block: drop straight back to idle so the
   * analysis their quota refused can be retried immediately.
   */
  /**
   * The user bought a credit pack from the quota block: same reset as
   * onUpgraded. The monthly quota is still exhausted — the next analysis draws
   * on a credit instead, which check_and_consume_entitlement decides
   * server-side — so this only clears the blocked UI state.
   */
  protected onCreditsAdded(): void {
    // Re-read the quota for the same reason as onUpgraded: the quota block's
    // copy is stale once the user has paid, and must not survive into idle.
    void this.refreshQuota();
    this.reset();
  }

  protected onUpgraded(): void {
    // Re-read the quota before resetting: the plan changed, so the pre-upgrade
    // "no analyses left" state must not survive into idle.
    void this.refreshQuota();
    this.reset();
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
