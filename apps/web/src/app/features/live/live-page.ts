import { DatePipe, DecimalPipe, isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

import type { Instrument, MarketTick } from '@chartanalyzer/shared';
import { AuthService } from '../../core/auth.service';
import { AnalysisResult } from '../analyze/analysis-result';
import type { AnalysisPattern, AnalysisRow } from '../analyze/analysis.types';
import { LiveChart, type ChartOverlays, type LiveCandle } from '../../shared/live-chart/live-chart';
import { ChartCaptureService } from '../../shared/live-chart/chart-capture.service';
import { AnalyzeService, type PollHandle } from '../analyze/analyze.service';
import { LiveService } from './live.service';
import { MarketStreamService } from './market-stream.service';
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

/**
 * The intraday poll cadence once the live socket is delivering ticks. The
 * poll is no longer what moves the chart's right-hand edge — ticks do that —
 * so it drops back to its remaining job: picking up candles after they close,
 * and correcting the streamed candle against the provider's own numbers.
 * The daily cadence is already slow enough to need no streaming variant.
 */
const STREAMING_INTRADAY_REFRESH_MS = 2 * 60_000;

/**
 * Floor on how often a candle rollover may trigger an out-of-band refetch.
 * A rollover is the one moment the timer above is too slow to hide — the
 * streamed price has moved into a candle this page does not have yet — so it
 * fetches immediately instead of waiting, and this keeps that from becoming a
 * per-tick request if the bucket maths ever disagrees with the provider's.
 */
const ROLLOVER_REFETCH_MIN_GAP_MS = 5_000;

type AnalyzeState = 'idle' | 'starting' | 'processing' | 'complete' | 'failed' | 'quota_exceeded';

/** The exact chart an analysis run belongs to: one instrument, one window. */
interface AnalysisTarget {
  instrumentId: string;
  symbol: string;
  lookbackDays: number;
}

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
  // The one implementation of "watch an analyses row until it settles",
  // shared with the upload flow rather than reimplemented here.
  private readonly analyses = inject(AnalyzeService);
  private readonly chartCapture = inject(ChartCaptureService);
  private readonly stream = inject(MarketStreamService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Raised when the user needs to buy more analyses — the shell opens plans. */
  readonly plansRequested = output<void>();
  /**
   * Raised by "Manual Analysis" — carries the instrument on screen here (if
   * any) so the workspace tab opens on the same chart instead of an empty
   * search box. The shell owns switching tabs; this screen only asks.
   */
  readonly manualAnalysisRequested = output<string | undefined>();

  protected readonly lookbackOptions = LOOKBACK_OPTIONS;

  protected readonly queryInput = signal('');
  protected readonly results = signal<Instrument[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly instrument = signal<Instrument | null>(null);

  protected readonly lookbackDays = signal<number>(1);
  protected readonly candles = signal<LiveCandle[]>([]);
  protected readonly timeframeLabel = signal<string | null>(null);
  protected readonly intervalMinutes = signal(0);
  protected readonly loadingChart = signal(false);
  protected readonly chartError = signal<string | null>(null);
  protected readonly lastRefreshedAt = signal<string | null>(null);

  /**
   * Last price from the live socket, kept apart from the candles because a
   * tick can arrive for a candle this page has not fetched yet — the readout
   * should still move in that gap even though the chart cannot.
   */
  private readonly streamPrice = signal<number | null>(null);
  /** True while the socket is confirmed subscribed to the shown instrument. */
  protected readonly streaming = this.stream.streaming;

  protected readonly analyzeState = signal<AnalyzeState>('idle');
  protected readonly analyzeError = signal<string | null>(null);
  protected readonly row = signal<AnalysisRow | null>(null);
  protected readonly patterns = signal<AnalysisPattern[]>([]);

  /**
   * What the in-flight run is for, or null.
   *
   * A run is paid for the moment it starts, so changing the window or the
   * symbol while one is in flight no longer abandons it — this is what lets
   * the view keep saying which chart is still being analysed after the user
   * has moved on to looking at another one.
   */
  protected readonly runningFor = signal<AnalysisTarget | null>(null);

  /**
   * A finished analysis for an instrument the user has since navigated away
   * from. Surfaced as a note rather than dropped silently: the quota unit was
   * spent and the result is real, it just does not belong on this chart.
   */
  protected readonly finishedElsewhere = signal<AnalysisTarget | null>(null);

  /**
   * The live price shown next to the symbol: a streamed tick when one has
   * arrived for this instrument, otherwise the latest close from the polled
   * candles. Falling back rather than requiring the stream is deliberate —
   * outside market hours, and whenever the socket is unavailable, this shows
   * exactly what it showed before streaming existed.
   */
  protected readonly lastPrice = computed(() => {
    const streamed = this.streamPrice();
    if (streamed !== null) return streamed;
    const candles = this.candles();
    return candles.length > 0 ? candles[candles.length - 1].close : null;
  });

  /**
   * Analysis levels, fed to the chart as price lines.
   *
   * Drawn only while the chart on screen is the one they were read from. A
   * support level from a one-day intraday chart means nothing painted over a
   * one-year daily chart, so switching either the symbol or the window takes
   * the lines down without discarding the analysis itself.
   */
  protected readonly overlays = computed<ChartOverlays | null>(() => {
    const row = this.row();
    const instrument = this.instrument();
    if (!row || row.status !== 'complete' || !instrument) return null;
    if (row.instrument_id !== instrument.id) return null;
    if (row.analysis_lookback_days !== this.lookbackDays()) return null;
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
  private pending: PollHandle | null = null;
  /** Releases the socket's subscription for the current instrument. */
  private stopStream: (() => void) | null = null;
  private lastRolloverFetchAt = 0;
  /** Guards against a slow fetch for an abandoned symbol/window painting over
   *  the current one. Incremented on every user-initiated chart change. */
  private requestSeq = 0;

  constructor() {
    // The poll cadence depends on whether ticks are arriving, and that can
    // flip at any time (socket connects, drops, reconnects). Re-arming the
    // timer from an effect keeps the two in step without the socket needing
    // to know a timer exists.
    effect(() => {
      const streaming = this.stream.streaming();
      void streaming;
      if (!this.isBrowser || !this.instrument()) return;
      this.startRefreshing();
    });
  }

  ngOnInit(): void {
    this.querySubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((q) => this.search(q)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((instruments) => {
        this.results.set(instruments);
        this.searching.set(false);
        this.searched.set(true);
      });

    // refresh() declines to poll a backgrounded tab, so coming back to one
    // meant looking at candles as old as the last interval — up to five minutes
    // on a daily window — until the next tick. Catch up on return instead.
    if (this.isBrowser) {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    this.destroyRef.onDestroy(() => this.teardown());
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (!this.instrument()) return;
    void this.refresh();
  };

  private teardown(): void {
    if (this.isBrowser) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.stopRefreshing();
    this.stopStreaming();
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

  /**
   * Dismisses the suggestion list without choosing anything.
   *
   * The list had no way out other than picking a row or emptying the field: it
   * covered the chart underneath it until one of those happened.
   */
  protected dismissResults(): void {
    this.results.set([]);
    this.searched.set(false);
  }

  /**
   * Empties the search box and returns focus to it.
   *
   * Selecting an instrument replaces the query with "SYM — Name", so searching
   * again meant selecting all that text and deleting it by hand first. The
   * chart itself is deliberately left alone — clearing the box is a step
   * towards a new search, not a request to throw away what is on screen.
   */
  protected clearQuery(input: HTMLInputElement): void {
    this.onQueryChange('');
    input.focus();
  }

  protected selectInstrument(instrument: Instrument): void {
    this.instrument.set(instrument);
    this.queryInput.set(`${instrument.symbol} — ${instrument.name}`);
    this.results.set([]);
    this.searched.set(false);
    this.clearResult();
    void this.reload();
  }

  protected selectLookback(days: number): void {
    if (days === this.lookbackDays()) return;
    this.lookbackDays.set(days);
    // A different window is a different chart, so the previous analysis's
    // levels stop applying — overlays() drops them on its own. The result
    // itself, and any run still in flight, are deliberately left alone.
    this.clearResult();
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
    this.startStreaming(instrument.id);
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
    this.intervalMinutes.set(result.window.intervalMinutes);
    this.lastRefreshedAt.set(new Date().toISOString());
  }

  private startRefreshing(): void {
    // Clearing first makes this idempotent, which it has to be: reload() stops
    // the timer, awaits the fetch, then starts it again — and the effect in the
    // constructor can fire during that await and start one of its own. Without
    // this the second call overwrote the handle of a timer that was already
    // running, leaking one uncancellable poll per symbol or window change.
    this.stopRefreshing();

    // No timers during SSR, and none while the tab is hidden — see refresh().
    if (!this.isBrowser || !this.instrument()) return;
    const intraday = this.lookbackDays() <= INTRADAY_MAX_LOOKBACK_DAYS;
    const intradayInterval = this.stream.streaming()
      ? STREAMING_INTRADAY_REFRESH_MS
      : INTRADAY_REFRESH_MS;
    const interval = intraday ? intradayInterval : DAILY_REFRESH_MS;
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

  /**
   * Points the live socket at `instrumentId`. Only the price side of the view
   * depends on this: if the socket never connects, everything here keeps
   * working off the REST poll.
   */
  private startStreaming(instrumentId: string): void {
    this.stopStreaming();
    if (!this.isBrowser) return;
    this.stopStream = this.stream.watchInstrument(instrumentId, (tick) => this.applyTick(tick));
  }

  private stopStreaming(): void {
    this.stopStream?.();
    this.stopStream = null;
    this.streamPrice.set(null);
  }

  /**
   * Folds one streamed price into the view: the price readout always, and the
   * candle currently forming when the tick actually belongs to it.
   *
   * The bucket check is the point. A tick past the last candle's interval
   * belongs to a candle this page has not been given, and inventing one from a
   * single price would put a candle on the chart — and into the image the
   * model reads — that no exchange ever printed. That tick moves the readout
   * and nothing else; the next poll brings the real candle.
   */
  private applyTick(tick: MarketTick): void {
    if (!Number.isFinite(tick.price)) return;
    this.streamPrice.set(tick.price);

    const candles = this.candles();
    const last = candles[candles.length - 1];
    const intervalMs = this.intervalMinutes() * 60_000;
    if (!last || intervalMs <= 0) return;

    const openedAt = Date.parse(last.timestamp);
    if (Number.isNaN(openedAt)) return;
    // Out-of-order and late ticks are both possible on a reconnect.
    if (tick.time < openedAt) return;
    if (tick.time >= openedAt + intervalMs) {
      // The price has moved into a candle that has not been fetched. Ask for
      // it now rather than letting the chart sit frozen until the next timer
      // tick — that gap was the whole of the pause at every interval
      // boundary, and it is the moment a live chart most needs to move.
      this.requestRolloverRefetch();
      return;
    }

    this.candles.set([
      ...candles.slice(0, -1),
      {
        ...last,
        close: tick.price,
        high: Math.max(last.high, tick.price),
        low: Math.min(last.low, tick.price),
      },
    ]);
  }

  /** Fetches the newly-opened candle, at most once per gap. */
  private requestRolloverRefetch(): void {
    const now = Date.now();
    if (now - this.lastRolloverFetchAt < ROLLOVER_REFETCH_MIN_GAP_MS) return;
    this.lastRolloverFetchAt = now;
    void this.refresh();
  }

  /**
   * Clears the displayed result, leaving any in-flight run alone.
   *
   * Deliberately not a cancel. A run is charged the moment it starts, so
   * changing the window or the symbol while one is in flight used to throw
   * away an analysis the user had already paid for — it completed server-side
   * and they never saw it. Now only what is on screen is cleared; the run
   * itself keeps going and reports back through analyze() below.
   */
  private clearResult(): void {
    this.analyzeError.set(null);
    this.row.set(null);
    this.patterns.set([]);
    this.finishedElsewhere.set(null);
    // A run still in flight keeps the view busy; only an idle view goes idle.
    if (!this.busy()) this.analyzeState.set('idle');
  }

  /** True while the result on screen was read from the chart on screen. */
  protected readonly resultApplies = computed(() => {
    const row = this.row();
    const instrument = this.instrument();
    return row !== null && instrument !== null && row.instrument_id === instrument.id;
  });

  /**
   * The result is for this instrument but a different window — worth saying,
   * since its levels are not drawn on the chart in that case.
   */
  protected readonly resultWindowDiffers = computed(() => {
    const row = this.row();
    return (
      this.resultApplies() &&
      row?.status === 'complete' &&
      row.analysis_lookback_days !== this.lookbackDays()
    );
  });

  protected windowLabel(days: number | null): string {
    return LOOKBACK_OPTIONS.find((option) => option.days === days)?.label ?? `${days} days`;
  }

  protected dismissFinishedElsewhere(): void {
    this.finishedElsewhere.set(null);
  }

  protected async analyze(): Promise<void> {
    const instrument = this.instrument();
    if (!instrument || this.busy()) return;

    // Captured now: the user is free to change either while this runs, and the
    // result belongs to the chart as it was when they pressed the button.
    const target: AnalysisTarget = {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      lookbackDays: this.lookbackDays(),
    };

    this.clearResult();
    this.analyzeState.set('starting');
    this.runningFor.set(target);

    // The image is rendered here, from the candles already on screen, and
    // posted with the request purely so the stored analysis keeps the exact
    // chart the user was looking at, to view and download later. The analysis
    // itself is made from the candle data server-side, not from this picture.
    // A null capture is not an error — the API falls back to its own renderer.
    const chart = await this.chartCapture.capture(this.candles(), {
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      timeframeLabel: this.timeframeLabel(),
    });

    const started = await this.live.startAnalysis(target.instrumentId, target.lookbackDays, chart);
    if (!started.ok) {
      this.runningFor.set(null);
      this.analyzeState.set(started.reason === 'quota_exceeded' ? 'quota_exceeded' : 'failed');
      this.analyzeError.set(started.message);
      return;
    }

    this.analyzeState.set('processing');
    // Watched by row id, so a run that fails reports 'failed' as soon as the
    // pipeline records it rather than after a three-minute client timeout.
    const handle = this.analyses.pollAnalysis(started.analysisId, () => {
      /* Intermediate states are not rendered here; only the outcome matters. */
    });
    this.pending = handle;

    const outcome = await handle.result;
    if (this.pending !== handle) return;
    this.pending = null;
    this.runningFor.set(null);

    if (outcome.outcome === 'complete' || outcome.outcome === 'failed') {
      this.row.set(outcome.row);
      this.patterns.set(outcome.outcome === 'complete' ? outcome.patterns : []);
      this.analyzeState.set(outcome.outcome === 'complete' ? 'complete' : 'failed');
      // The user moved to a different symbol while this ran. The result is
      // real and already in their history, so point at it rather than
      // rendering it over a chart it was not read from.
      if (this.instrument()?.id !== target.instrumentId) {
        this.finishedElsewhere.set(target);
      }
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

  protected requestManualAnalysis(): void {
    this.manualAnalysisRequested.emit(this.instrument()?.id);
  }
}
