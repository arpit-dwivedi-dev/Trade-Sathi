import { DatePipe, DecimalPipe, isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

import type { Instrument } from '@chartanalyzer/shared';
import { AuthService } from '../../core/auth.service';
import { AnalysisResult } from '../analyze/analysis-result';
import type { AnalysisPattern, AnalysisRow } from '../analyze/analysis.types';
import { LiveChart, type ChartOverlays, type LiveCandle } from '../../shared/live-chart/live-chart';
import { ChartCaptureService } from '../../shared/live-chart/chart-capture.service';
import { LiveService, type LiveAnalysisHandle } from './live.service';
import { HttpClient } from '@angular/common/http';

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/**
 * Chart windows offered here, in days — the same shortlist the watchlist
 * offers, because the same server-side candleSpecFor turns each one into a
 * granularity. Short windows are drawn from intraday candles, so a 1-day
 * chart is a real chart rather than a single candle.
 */
const LOOKBACK_OPTIONS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
] as const;

/**
 * How often the chart refetches. Intraday windows form a new candle every
 * 5-30 minutes but the last one keeps moving, so they refresh on a short
 * timer; a daily chart gains at most one candle a day. Both sit at or above
 * the server-side cache TTLs, so a poll costs the upstream provider nothing
 * most of the time.
 */
const INTRADAY_REFRESH_MS = 30_000;
const DAILY_REFRESH_MS = 5 * 60_000;
const INTRADAY_MAX_LOOKBACK_DAYS = 7;

type AnalyzeState = 'idle' | 'starting' | 'processing' | 'complete' | 'failed' | 'quota_exceeded';

/**
 * The live chart view: search any instrument, watch its candles update, and
 * run the same AI analysis on the window currently on screen.
 *
 * The chart the user pans here and the chart the model reads are the same
 * data — the API renders its own image from the identical candles — so the
 * returned levels can be drawn straight onto this chart as price lines.
 */
@Component({
  selector: 'app-live-page',
  imports: [AnalysisResult, DatePipe, DecimalPipe, FormsModule, LiveChart],
  templateUrl: './live-page.html',
  styleUrl: './live-page.css',
})
export class LivePage implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly live = inject(LiveService);
  private readonly chartCapture = inject(ChartCaptureService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Raised when the user needs to buy more analyses — the shell opens plans. */
  readonly plansRequested = output<void>();

  protected readonly lookbackOptions = LOOKBACK_OPTIONS;

  protected readonly queryInput = signal('');
  protected readonly results = signal<Instrument[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly instrument = signal<Instrument | null>(null);

  protected readonly lookbackDays = signal<number>(90);
  protected readonly candles = signal<LiveCandle[]>([]);
  protected readonly timeframeLabel = signal<string | null>(null);
  protected readonly loadingChart = signal(false);
  protected readonly chartError = signal<string | null>(null);
  protected readonly lastRefreshedAt = signal<string | null>(null);

  protected readonly analyzeState = signal<AnalyzeState>('idle');
  protected readonly analyzeError = signal<string | null>(null);
  protected readonly row = signal<AnalysisRow | null>(null);
  protected readonly patterns = signal<AnalysisPattern[]>([]);

  /** The latest close, shown as the live price next to the symbol. */
  protected readonly lastPrice = computed(() => {
    const candles = this.candles();
    return candles.length > 0 ? candles[candles.length - 1].close : null;
  });

  /** Analysis levels, fed to the chart as price lines. Cleared with the row. */
  protected readonly overlays = computed<ChartOverlays | null>(() => {
    const row = this.row();
    if (!row || row.status !== 'complete') return null;
    return {
      support: row.support_levels ?? [],
      resistance: row.resistance_levels ?? [],
      entry: row.call_entry,
      target: row.call_target,
      invalidation: row.call_invalidation,
    };
  });

  protected readonly busy = computed(
    () => this.analyzeState() === 'starting' || this.analyzeState() === 'processing',
  );

  private readonly querySubject = new Subject<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pending: LiveAnalysisHandle | null = null;
  /** Guards against a slow fetch for an abandoned symbol/window painting over
   *  the current one. Incremented on every user-initiated chart change. */
  private requestSeq = 0;

  ngOnInit(): void {
    this.querySubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((q) => this.search(q)),
      )
      .subscribe((instruments) => {
        this.results.set(instruments);
        this.searching.set(false);
        this.searched.set(true);
      });

    this.destroyRef.onDestroy(() => this.teardown());
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  private teardown(): void {
    this.stopRefreshing();
    this.pending?.cancel();
    this.pending = null;
  }

  protected onQueryChange(value: string): void {
    this.queryInput.set(value);
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      this.results.set([]);
      this.searching.set(false);
      this.searched.set(false);
      return;
    }
    this.searching.set(true);
    this.querySubject.next(trimmed);
  }

  private async search(query: string): Promise<Instrument[]> {
    const token = await this.auth.getAccessToken();
    if (!token) return [];
    try {
      const response = await firstValueFrom(
        this.http.get<{ instruments: Instrument[] }>('/api/instruments/search', {
          params: { q: query },
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return response.instruments;
    } catch {
      return [];
    }
  }

  protected selectInstrument(instrument: Instrument): void {
    this.instrument.set(instrument);
    this.queryInput.set(`${instrument.symbol} — ${instrument.name}`);
    this.results.set([]);
    this.searched.set(false);
    this.resetAnalysis();
    void this.reload();
  }

  protected selectLookback(days: number): void {
    if (days === this.lookbackDays()) return;
    this.lookbackDays.set(days);
    // A different window is a different chart: the previous analysis was read
    // from candles that are no longer on screen, so its levels stop applying.
    this.resetAnalysis();
    void this.reload();
  }

  /** Fetches the window and (re)starts the refresh timer for its cadence. */
  private async reload(): Promise<void> {
    const instrument = this.instrument();
    if (!instrument) return;

    this.stopRefreshing();
    this.loadingChart.set(true);
    await this.fetchWindow(instrument.id, this.lookbackDays());
    this.loadingChart.set(false);
    this.startRefreshing();
  }

  private async fetchWindow(instrumentId: string, lookbackDays: number): Promise<void> {
    const seq = ++this.requestSeq;
    const result = await this.live.fetchCandles(instrumentId, lookbackDays);
    if (seq !== this.requestSeq) return;

    if (!result.ok) {
      this.chartError.set(result.message);
      return;
    }
    this.chartError.set(null);
    this.candles.set(result.window.candles);
    this.timeframeLabel.set(result.window.timeframeLabel);
    this.lastRefreshedAt.set(new Date().toISOString());
  }

  private startRefreshing(): void {
    // No timers during SSR, and none while the tab is hidden — see refresh().
    if (!this.isBrowser || !this.instrument()) return;
    const interval =
      this.lookbackDays() <= INTRADAY_MAX_LOOKBACK_DAYS ? INTRADAY_REFRESH_MS : DAILY_REFRESH_MS;
    this.refreshTimer = setInterval(() => void this.refresh(), interval);
  }

  private stopRefreshing(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refresh(): Promise<void> {
    const instrument = this.instrument();
    if (!instrument) return;
    // A backgrounded tab is not being watched; polling it only spends the
    // provider's rate limit. The next visible tick catches up.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    await this.fetchWindow(instrument.id, this.lookbackDays());
  }

  private resetAnalysis(): void {
    this.pending?.cancel();
    this.pending = null;
    this.analyzeState.set('idle');
    this.analyzeError.set(null);
    this.row.set(null);
    this.patterns.set([]);
  }

  protected async analyze(): Promise<void> {
    const instrument = this.instrument();
    if (!instrument || this.busy()) return;

    this.resetAnalysis();
    this.analyzeState.set('starting');

    // The image is rendered here, from the candles already on screen, and
    // posted with the request: the model then reads the same chart the user
    // is looking at rather than a server-side redraw of the same data. A null
    // capture is not an error — the API falls back to its own renderer.
    const chart = await this.chartCapture.capture(this.candles(), {
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      timeframeLabel: this.timeframeLabel(),
    });

    const started = await this.live.startAnalysis(instrument.id, this.lookbackDays(), chart);
    if (!started.ok) {
      this.analyzeState.set(started.reason === 'quota_exceeded' ? 'quota_exceeded' : 'failed');
      this.analyzeError.set(started.message);
      return;
    }

    this.analyzeState.set('processing');
    const handle = this.live.awaitAnalysis(instrument.id, started.startedAt);
    this.pending = handle;

    const outcome = await handle.result;
    if (this.pending !== handle) return;
    this.pending = null;

    if (outcome.outcome === 'complete') {
      this.row.set(outcome.row);
      this.patterns.set(outcome.patterns);
      this.analyzeState.set('complete');
      return;
    }

    this.analyzeState.set('failed');
    this.analyzeError.set(
      outcome.outcome === 'timed_out'
        ? "This is taking longer than expected. If it finished, it'll be in your history."
        : 'Could not read the finished analysis. Check your connection and try again.',
    );
  }

  protected openPlans(): void {
    this.plansRequested.emit();
  }
}
