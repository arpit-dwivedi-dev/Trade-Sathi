import { Component, OnDestroy, OnInit, inject, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';

import { LottiePlayer } from '../../shared/lottie-player';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';
import { AnalyzeService, type PollHandle } from './analyze.service';
import { ChartDrop, type ChartFileSelection } from './chart-drop';

type AnalyzeState =
  | 'idle'
  | 'uploading'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'insufficient_credits'
  | 'timed_out'
  | 'poll_error';

/**
 * Owns the upload → poll → result state machine and wires the pieces together.
 */
@Component({
  selector: 'app-analyze-page',
  imports: [
    ChartDrop,
    ButtonModule,
    CardModule,
    LottiePlayer,
    RouterLink,
  ],
  styleUrl: './analyze-page.css',
  templateUrl: './analyze-page.html',
})
export class AnalyzePage implements OnInit, OnDestroy {
  private readonly analyze = inject(AnalyzeService);

  /**
   * Asks the shell to switch to the billing tab. Routed through the shell
   * rather than navigated here directly so both entry points — the nav
   * control and this page's out-of-credits block — behave identically.
   */
  readonly plansRequested = output<void>();

  protected readonly state = signal<AnalyzeState>('idle');
  protected readonly row = signal<AnalysisRow | null>(null);
  protected readonly patterns = signal<AnalysisPattern[]>([]);
  /**
   * The id of the analysis being polled, known as soon as it's submitted.
   * The "view report" link is driven by this rather than `row`, since `row`
   * only fills in once a poll tick returns a row and shouldn't gate the link.
   */
  protected readonly analysisId = signal<string | null>(null);
  /** Set only for a failed submission; otherwise the state carries the copy. */
  protected readonly error = signal<string | null>(null);
  /**
   * The credit balance, read on load. null means "not known" (SSR, no
   * session, read error) — the upload path stays open in that case and the
   * backend's 402 remains the authority.
   */
  protected readonly balance = signal<number | null>(null);

  private poll: PollHandle | null = null;

  ngOnInit(): void {
    void this.refreshBalance();
  }

  /** True only when the balance is known *and* zero. */
  protected balanceExhausted(): boolean {
    const balance = this.balance();
    return balance !== null && balance <= 0;
  }

  private async refreshBalance(): Promise<void> {
    this.balance.set(await this.analyze.fetchCreditBalance());
  }

  protected async onFileSelected(selection: ChartFileSelection): Promise<void> {
    // Belt and braces: chart-drop is already given disabled=true off-idle/off-complete.
    if (this.state() !== 'idle' && this.state() !== 'complete') return;

    this.state.set('uploading');
    this.error.set(null);
    this.row.set(null);
    this.patterns.set([]);
    this.analysisId.set(null);

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
      // insufficient_credits is an expected, common outcome rather than a bug
      // state, so it keeps its own friendly copy from the service and its own
      // state — that state is what offers the buy-credits path instead of just
      // an error.
      this.error.set(submitted.message);
      if (submitted.reason === 'insufficient_credits') {
        // The cached balance disagreed with the backend, which is authoritative.
        void this.refreshBalance();
        this.state.set('insufficient_credits');
      } else {
        this.state.set('failed');
      }
      return;
    }

    void this.refreshBalance();
    this.analysisId.set(submitted.id);
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
   * The user bought credits: drop straight back to idle so the analysis the
   * balance check refused can be retried immediately. Called by the shell
   * when the billing tab reports a successful purchase, from either entry
   * point.
   */
  onCreditsAdded(): void {
    // Re-read the balance so the stale "not enough credits" copy doesn't
    // survive into idle.
    void this.refreshBalance();
    this.reset();
  }

  protected reset(): void {
    this.poll?.cancel();
    this.poll = null;
    this.row.set(null);
    this.patterns.set([]);
    this.analysisId.set(null);
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
