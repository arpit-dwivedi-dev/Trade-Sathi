import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  effect,
  inject,
  output,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';

import {
  clearPendingAnalysis,
  loadPendingAnalysis,
  savePendingAnalysis,
} from '../../core/pending-analysis-store';
import { LottiePlayer } from '../../shared/lottie-player';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';
import { AnalyzeService, type PollHandle } from './analyze.service';
import { ChartDrop, type ChartFileSelection } from './chart-drop';
import { inspectImageQuality, type ImageQualityIssue } from './image-quality';

type AnalyzeState =
  | 'idle'
  | 'confirming'
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
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

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

  /**
   * The file held back by the pre-upload quality check, with what was wrong
   * with it. Non-null exactly while state is 'confirming' — the user either
   * accepts the warning and this is submitted, or cancels and it's dropped
   * without ever costing a credit.
   */
  protected readonly pendingSelection = signal<ChartFileSelection | null>(null);
  protected readonly qualityIssues = signal<ImageQualityIssue[]>([]);

  private readonly qualityDialog = viewChild<ElementRef<HTMLElement>>('qualityDialog');

  private poll: PollHandle | null = null;

  constructor() {
    // The dialog only exists once the @if opens, and Escape is bound on it, so
    // it has to take focus or the keyboard path is dead.
    effect(() => {
      if (this.state() !== 'confirming') return;
      this.qualityDialog()?.nativeElement.focus();
    });
  }

  ngOnInit(): void {
    void this.refreshBalance();
    this.resumePending();
  }

  /**
   * Picks an upload back up after a reload.
   *
   * The credit is spent and the pipeline runs server-side the moment the image
   * is accepted, so a refresh mid-run must not drop the user back to an empty
   * upload box. The row id was remembered at submit time; watching it again is
   * all it takes, and if it finished while the page was gone the first read
   * settles immediately with the result.
   */
  private resumePending(): void {
    const pending = loadPendingAnalysis(this.isBrowser, 'upload');
    if (!pending) return;

    this.analysisId.set(pending.id);
    this.state.set('processing');
    this.startPolling(pending.id);
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

    // Free, local screening before anything is spent. Purely advisory: if it
    // finds something, the user is shown it and decides. If the inspection
    // itself fails, it's treated as "nothing found" rather than blocking an
    // upload over a heuristic that couldn't run.
    let issues: ImageQualityIssue[] = [];
    try {
      issues = (await inspectImageQuality(selection.file)).issues;
    } catch {
      issues = [];
    }

    if (issues.length > 0) {
      this.qualityIssues.set(issues);
      this.pendingSelection.set(selection);
      this.state.set('confirming');
      return;
    }

    await this.runAnalysis(selection);
  }

  /** The user read the warning and chose to spend the credit anyway. */
  protected confirmPending(): void {
    const selection = this.pendingSelection();
    if (!selection || this.state() !== 'confirming') return;

    this.pendingSelection.set(null);
    this.qualityIssues.set([]);
    void this.runAnalysis(selection);
  }

  /** The user backed out. Nothing was uploaded, so no credit was spent. */
  protected cancelPending(): void {
    if (this.state() !== 'confirming') return;

    this.pendingSelection.set(null);
    this.qualityIssues.set([]);
    this.state.set('idle');
  }

  private async runAnalysis(selection: ChartFileSelection): Promise<void> {
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
    savePendingAnalysis(this.isBrowser, 'upload', { id: submitted.id, startedAt: Date.now() });
    this.analysisId.set(submitted.id);
    this.state.set('processing');
    this.startPolling(submitted.id);
  }

  private startPolling(id: string): void {
    const handle = this.analyze.pollAnalysis(id, (row) => this.row.set(row));
    this.poll = handle;

    void handle.result.then((outcome) => {
      this.poll = null;

      // 'timed_out' keeps the remembered run: the backend may still be working
      // on it, so a later reload should pick it up again rather than forget it.
      if (outcome.outcome !== 'timed_out') {
        clearPendingAnalysis(this.isBrowser, 'upload');
      }

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
    clearPendingAnalysis(this.isBrowser, 'upload');
    this.poll?.cancel();
    this.poll = null;
    this.pendingSelection.set(null);
    this.qualityIssues.set([]);
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
