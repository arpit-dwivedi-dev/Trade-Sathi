import { DecimalPipe, isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ChipModule } from 'primeng/chip';
import { Popover } from 'primeng/popover';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectButtonModule } from 'primeng/selectbutton';

import { type MarketTick } from '@tradesathi/shared';
import { LiveService, type WorkspaceInterval } from '../../core/live.service';
import { MarketStreamService } from '../../core/market-stream.service';
import { AppIcon } from '../../shared/icons/app-icon';
import type { IconName } from '../../shared/icons/icon-paths';
import type { ChartOverlays, ChartStyle, LiveCandle, OverlayBand } from '../../shared/live-chart/live-chart';
import { ChartCaptureService } from '../../shared/live-chart/chart-capture.service';
import type { SymbolSelection } from '../../shared/symbol-search/symbol-search';
import { AnalysisResult } from '../analyze/analysis-result';
import type { AnalysisPattern, AnalysisRow } from '../analyze/analysis.types';
import { AnalyzeService, type PollHandle } from '../analyze/analyze.service';
import { WorkspaceChart } from './chart/workspace-chart';
import { loadDrawings, saveDrawings } from './drawing/drawing-store';
import {
  DRAWING_ICONS,
  DRAWING_LABELS,
  TOOL_GROUPS,
  type Drawing,
  type DrawingKind,
  type DrawTool,
  type ToolGroup,
} from './drawing/drawing.types';
import { IndicatorMenu, type IndicatorKind } from './indicators/indicator-menu';
import { loadIndicators, saveIndicators } from './indicators/indicator-store';

/** The instrument shape both a search result and a candle-window response carry — see LiveService.fetchCandles. */
interface WorkspaceInstrument {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
}

interface TimeframeOption {
  value: WorkspaceInterval;
  label: string;
  /** Default history fetched for this granularity — the same "pair a window with its granularity" pattern live-page.ts uses. */
  lookbackDays: number;
}

const TIMEFRAMES: readonly TimeframeOption[] = [
  { value: '1m', label: '1m', lookbackDays: 1 },
  { value: '5m', label: '5m', lookbackDays: 5 },
  { value: '15m', label: '15m', lookbackDays: 10 },
  { value: '30m', label: '30m', lookbackDays: 30 },
  { value: '60m', label: '1H', lookbackDays: 90 },
  { value: '1d', label: '1D', lookbackDays: 365 },
];
const DEFAULT_TIMEFRAME: WorkspaceInterval = '1d';

interface ChartStyleOption {
  value: ChartStyle;
  label: string;
}

const CHART_STYLES: readonly ChartStyleOption[] = [
  { value: 'candle', label: 'Candle' },
  { value: 'line', label: 'Line' },
];

const INTRADAY_REFRESH_MS = 30_000;
const DAILY_REFRESH_MS = 5 * 60_000;
const STREAMING_INTRADAY_REFRESH_MS = 2 * 60_000;
const ROLLOVER_REFETCH_MIN_GAP_MS = 5_000;

type AnalyzeState =
  | 'idle'
  | 'starting'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'insufficient_credits';

/** The exact chart an analysis run belongs to: one instrument, one timeframe's lookback. */
interface AnalysisTarget {
  instrumentId: string;
  symbol: string;
  lookbackDays: number;
}

/**
 * The Chart Analysis workspace: a tab in the dashboard shell (not a
 * separate route) for picking an instrument, switching candle timeframe,
 * drawing on the chart, and running AI analysis on the window currently on
 * screen. Reached via the nav rail's own tab entry.
 *
 * The instrument itself is not picked here: the shell's top-bar search owns
 * that for every chart tab, and hands the choice down through `selection`.
 *
 * Staying a tab rather than its own route is deliberate: the dashboard nav
 * rail stays visible by default so the workspace never opens onto a blank,
 * disorienting screen. `toggleSidebar` and the real Fullscreen API (see
 * toggleFullscreen) are what let a user reclaim that space on their own
 * terms instead of it being taken from them automatically.
 */
@Component({
  selector: 'app-workspace-page',
  imports: [
    AnalysisResult,
    AppIcon,
    ButtonModule,
    ChipModule,
    DecimalPipe,
    FormsModule,
    IndicatorMenu,
    Popover,
    ProgressSpinnerModule,
    SelectButtonModule,
    WorkspaceChart,
  ],
  templateUrl: './workspace-page.html',
  styleUrl: './workspace-page.css',
})
export class WorkspacePage implements OnInit, OnDestroy {
  private readonly live = inject(LiveService);
  private readonly stream = inject(MarketStreamService);
  // The one implementation of "watch an analyses row until it settles",
  // shared with the upload flow and formerly Live rather than reimplemented here.
  private readonly analyses = inject(AnalyzeService);
  private readonly chartCapture = inject(ChartCaptureService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Raised when the user needs to buy more analyses — the shell opens plans. */
  readonly plansRequested = output<void>();

  /**
   * The instrument to chart, chosen in the shell's top-bar search. This
   * screen has no search box of its own.
   */
  readonly selection = input<SymbolSelection | null>(null);
  // p-selectButton's [options] wants a mutable array, so these are shallow
  // copies of the readonly module-level constants above.
  protected readonly timeframes: TimeframeOption[] = [...TIMEFRAMES];
  protected readonly toolGroups = TOOL_GROUPS;
  protected readonly chartStyles: ChartStyleOption[] = [...CHART_STYLES];

  private readonly shellHost = viewChild<ElementRef<HTMLDivElement>>('shell');
  /**
   * The fullscreened element, for PrimeNG's overlay-based components'
   * `[appendTo]` — a fullscreened element is the only subtree the browser
   * paints, so anything overlay-based inside `#shell` (the tool-menu popover,
   * the indicator menu's popover) has to render inside it rather than under
   * `<body>` to stay visible while fullscreen is active.
   */
  protected readonly shellElement = computed(() => this.shellHost()?.nativeElement);
  /** True while this screen (not the whole document) is Fullscreen-API-fullscreen. */
  protected readonly isFullscreen = signal(false);

  /** The drawings rail starts open, but can give the chart more room on demand. */
  protected readonly drawingsPanelOpen = signal(true);

  private readonly toolPopover = viewChild<Popover>('toolPopover');
  /** Which tool-rail group's flyout is open — read by the one shared popover template. */
  protected readonly openToolGroup = signal<ToolGroup | null>(null);

  /** Opens the shared tool-menu popover, filled with this rail button's group. */
  protected openToolMenu(event: Event, group: ToolGroup): void {
    this.openToolGroup.set(group);
    this.toolPopover()?.toggle(event);
  }

  /**
   * Closes the tool-menu popover after a tool is picked. PrimeNG's Popover,
   * unlike a Material mat-menu-item, does not dismiss itself on an inner
   * click — this replicates that one-shot-selection behaviour explicitly.
   */
  protected closeToolMenu(event: Event): void {
    this.toolPopover()?.hide();
    event.stopPropagation();
  }

  protected readonly instrument = signal<WorkspaceInstrument | null>(null);

  protected readonly timeframe = signal<WorkspaceInterval>(DEFAULT_TIMEFRAME);
  protected readonly chartStyle = signal<ChartStyle>('candle');
  protected readonly candles = signal<LiveCandle[]>([]);
  protected readonly loadingChart = signal(false);
  protected readonly chartError = signal<string | null>(null);
  protected readonly lastRefreshedAt = signal<string | null>(null);

  protected readonly tool = signal<DrawTool>('cursor');
  protected readonly drawings = signal<Drawing[]>([]);
  protected readonly selectedDrawingId = signal<string | null>(null);
  protected readonly activeIndicators = signal<ReadonlySet<IndicatorKind>>(new Set());

  private readonly streamPrice = signal<number | null>(null);
  protected readonly streaming = this.stream.streaming;

  protected readonly lastPrice = computed(() => {
    const streamed = this.streamPrice();
    if (streamed !== null) return streamed;
    const candles = this.candles();
    return candles.length > 0 ? candles[candles.length - 1].close : null;
  });

  /** NSE/BSE quote in rupees; everything else (NASDAQ, NYSE) in dollars. */
  protected readonly currencySymbol = computed(() => {
    const exchange = this.instrument()?.exchange;
    return exchange === 'NSE' || exchange === 'BSE' ? '₹' : '$';
  });

  protected readonly analyzeState = signal<AnalyzeState>('idle');
  protected readonly analyzeError = signal<string | null>(null);
  protected readonly row = signal<AnalysisRow | null>(null);
  protected readonly patterns = signal<AnalysisPattern[]>([]);

  /**
   * What the in-flight run is for, or null.
   *
   * A run is paid for the moment it starts, so changing the timeframe or the
   * symbol while one is in flight no longer abandons it — this is what lets
   * the view keep saying which chart is still being analysed after the user
   * has moved on to looking at another one.
   */
  protected readonly runningFor = signal<AnalysisTarget | null>(null);

  /**
   * A finished analysis for an instrument the user has since navigated away
   * from. Surfaced as a note rather than dropped silently: the credit was
   * spent and the result is real, it just does not belong on this chart.
   */
  protected readonly finishedElsewhere = signal<AnalysisTarget | null>(null);

  /**
   * Analysis levels, fed to the chart as price lines.
   *
   * Drawn only while the chart on screen is the one they were read from. A
   * support level from a one-minute chart means nothing painted over a
   * one-day chart, so switching either the symbol or the timeframe takes the
   * lines down without discarding the analysis itself.
   */
  protected readonly overlays = computed<ChartOverlays | null>(() => {
    /** A legacy single price, as the degenerate band the chart now draws. */
    const point = (price: number, label: string): OverlayBand => ({
      low: price,
      high: price,
      label,
    });

    const row = this.row();
    const instrument = this.instrument();
    if (!row || row.status !== 'complete' || !instrument) return null;
    if (row.instrument_id !== instrument.id) return null;
    if (row.analysis_lookback_days !== lookbackDaysFor(this.timeframe())) return null;
    const result = row.analysis_result;
    if (!result) {
      // Analyzed before the structured-read prompts: all this row has are
      // single prices, so each is drawn as a zero-width band.
      return {
        support: (row.support_levels ?? []).map((price) => point(price, 'S')),
        resistance: (row.resistance_levels ?? []).map((price) => point(price, 'R')),
        trigger: row.call_entry !== null ? [point(row.call_entry, 'Entry')] : [],
        targets: row.call_target !== null ? [row.call_target] : [],
        invalidations: row.call_invalidation !== null ? [row.call_invalidation] : [],
      };
    }

    // Zones, drawn as zones. Painting a band's midpoint as one line would
    // claim a precision the read explicitly refuses to.
    const zones = result.structure.levels;
    return {
      support: zones
        .filter((zone) => zone.kind === 'support')
        .map((zone) => ({ low: zone.low, high: zone.high, label: 'S' })),
      resistance: zones
        .filter((zone) => zone.kind === 'resistance')
        .map((zone) => ({ low: zone.low, high: zone.high, label: 'R' })),
      trigger: result.setup.scenarios.map((scenario) => ({
        low: scenario.trigger_low,
        high: scenario.trigger_high,
        label: scenario.direction === 'long' ? 'Long above' : 'Short below',
      })),
      targets: result.setup.scenarios
        .map((scenario) => scenario.target)
        .filter((target): target is number => target !== null),
      invalidations: result.setup.scenarios.map((scenario) => scenario.invalidation),
    };
  });

  protected readonly busy = computed(
    () => this.analyzeState() === 'starting' || this.analyzeState() === 'processing',
  );

  /** True while the result on screen was read from the chart on screen. */
  protected readonly resultApplies = computed(() => {
    const row = this.row();
    const instrument = this.instrument();
    return row !== null && instrument !== null && row.instrument_id === instrument.id;
  });

  /**
   * The result is for this instrument but a different timeframe — worth
   * saying, since its levels are not drawn on the chart in that case.
   */
  protected readonly resultWindowDiffers = computed(() => {
    const row = this.row();
    return (
      this.resultApplies() &&
      row?.status === 'complete' &&
      row.analysis_lookback_days !== lookbackDaysFor(this.timeframe())
    );
  });

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopStream: (() => void) | null = null;
  private pending: PollHandle | null = null;
  private lastRolloverFetchAt = 0;
  private intervalMinutes = 0;
  /** Guards a slow fetch for an abandoned symbol/timeframe from painting over the current one. */
  private requestSeq = 0;

  constructor() {
    // Re-arms the poll cadence whenever streaming connects/drops — the
    // cadence depends on whether ticks are arriving, and that can flip at any
    // time (socket connects, drops, reconnects), so this has to live in an
    // effect rather than a one-shot call.
    effect(() => {
      const streaming = this.stream.streaming();
      void streaming;
      if (!this.isBrowser || !this.instrument()) return;
      this.startRefreshing();
    });

    // Opens whatever the shell hands down, including the same symbol picked
    // twice in a row — see SymbolSelection's requestId for why that still
    // fires here.
    effect(() => {
      const selection = this.selection();
      if (!this.isBrowser || !selection) return;
      this.openInstrument(selection.instrument);
    });
  }

  ngOnInit(): void {
    if (this.isBrowser) {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      document.addEventListener('fullscreenchange', this.onFullscreenChange);
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

  /** Keeps isFullscreen in sync with reality — including an exit the browser drove itself (Escape, F11). */
  private readonly onFullscreenChange = (): void => {
    this.isFullscreen.set(document.fullscreenElement === this.shellHost()?.nativeElement);
  };

  private teardown(): void {
    if (this.isBrowser) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    }
    this.stopRefreshing();
    this.stopStreaming();
    this.pending?.cancel();
    this.pending = null;
  }

  /**
   * Real browser fullscreen (not a CSS trick) scoped to this screen's own
   * root element — the dashboard nav rail and topbar are siblings outside
   * it, so the Fullscreen API hides them for free without this needing to
   * know anything about the shell around it.
   */
  protected toggleFullscreen(): void {
    if (!this.isBrowser) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    // Can legitimately be refused — no user-gesture in the call stack, an
    // embedding iframe without allow="fullscreen", a browser that doesn't
    // support it at all. Same "enhancement, not a requirement" handling as
    // the live price stream: fail quietly, collapsing the rail still gets
    // most of the same room back.
    this.shellHost()
      ?.nativeElement.requestFullscreen()
      .catch(() => {
        /* not fatal — see above */
      });
  }

  /**
   * Charts an instrument handed down from the shell. Same symbol as the one
   * already open is still honoured — it is how a stale error state or a
   * dropped stream gets reset.
   */
  private openInstrument(instrument: WorkspaceInstrument): void {
    this.instrument.set(instrument);
    this.chartError.set(null);
    this.clearResult();
    void this.reload();
  }

  protected selectTimeframe(value: WorkspaceInterval): void {
    if (value === this.timeframe()) return;
    this.timeframe.set(value);
    // A different timeframe is a different chart, so the previous analysis's
    // levels stop applying — overlays() drops them on its own. The result
    // itself, and any run still in flight, are deliberately left alone.
    this.clearResult();
    void this.reload();
  }

  /** Purely a rendering choice — same candles, same analysis, so nothing else needs to change. */
  protected selectChartStyle(value: ChartStyle): void {
    this.chartStyle.set(value);
  }

  private async reload(): Promise<void> {
    const instrument = this.instrument();
    if (!instrument) return;

    this.stopRefreshing();
    this.loadingChart.set(true);
    await this.fetchWindow(instrument.id, this.timeframe());
    this.loadingChart.set(false);
    this.loadDrawingsAndIndicators();
    this.startRefreshing();
    this.startStreaming(instrument.id);
  }

  private async fetchWindow(instrumentId: string, timeframe: WorkspaceInterval): Promise<void> {
    const seq = ++this.requestSeq;
    const result = await this.live.fetchCandles(instrumentId, lookbackDaysFor(timeframe), timeframe);
    if (seq !== this.requestSeq) return;

    if (!result.ok) {
      this.chartError.set(result.message);
      return;
    }
    this.chartError.set(null);
    this.applyWindow(result.window.candles, result.window.intervalMinutes);
  }

  private applyWindow(candles: LiveCandle[], intervalMinutes: number): void {
    this.candles.set(candles);
    this.intervalMinutes = intervalMinutes;
    this.lastRefreshedAt.set(new Date().toISOString());
  }

  /** Drawings/indicators are keyed per instrument + timeframe — see drawing-store.ts / indicator-store.ts. */
  private loadDrawingsAndIndicators(): void {
    const instrument = this.instrument();
    if (!instrument) return;
    const timeframe = this.timeframe();
    this.drawings.set(loadDrawings(this.isBrowser, instrument.id, timeframe));
    this.selectedDrawingId.set(null);
    this.activeIndicators.set(new Set(loadIndicators(this.isBrowser, instrument.id, timeframe)));
  }

  private startRefreshing(): void {
    this.stopRefreshing();
    if (!this.isBrowser || !this.instrument()) return;
    const intraday = this.timeframe() !== '1d';
    const intradayInterval = this.stream.streaming() ? STREAMING_INTRADAY_REFRESH_MS : INTRADAY_REFRESH_MS;
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
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    await this.fetchWindow(instrument.id, this.timeframe());
  }

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

  /** Folds one streamed price into the view: the price readout always, and the candle currently forming when the tick actually belongs to it. */
  private applyTick(tick: MarketTick): void {
    if (!Number.isFinite(tick.price)) return;
    this.streamPrice.set(tick.price);

    const candles = this.candles();
    const last = candles[candles.length - 1];
    const intervalMs = this.intervalMinutes * 60_000;
    if (!last || intervalMs <= 0) return;

    const openedAt = Date.parse(last.timestamp);
    if (Number.isNaN(openedAt)) return;
    if (tick.time < openedAt) return;
    if (tick.time >= openedAt + intervalMs) {
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

  private requestRolloverRefetch(): void {
    const now = Date.now();
    if (now - this.lastRolloverFetchAt < ROLLOVER_REFETCH_MIN_GAP_MS) return;
    this.lastRolloverFetchAt = now;
    void this.refresh();
  }

  // ---- drawing tools ----

  protected selectTool(next: DrawTool): void {
    this.tool.set(this.tool() === next && next !== 'cursor' ? 'cursor' : next);
  }

  /**
   * The popover reads `openToolGroup()` rather than a typed template
   * context, so the label lookup goes through a typed method rather than
   * indexing the record from the template.
   */
  protected toolLabel(kind: DrawingKind): string {
    return DRAWING_LABELS[kind];
  }

  /** Same lookup, same reason — the flyout's per-tool glyph. */
  protected toolIcon(kind: DrawingKind): IconName {
    return DRAWING_ICONS[kind];
  }

  /** Lights up the rail button whose flyout holds the tool now armed. */
  protected isGroupActive(group: ToolGroup): boolean {
    const tool = this.tool();
    return tool !== 'cursor' && group.tools.includes(tool);
  }

  /**
   * A rail button holding the armed tool wears that tool's own glyph, so the
   * rail says which of the sixteen is live without the flyout being open.
   */
  protected groupIcon(group: ToolGroup): IconName {
    const tool = this.tool();
    return tool !== 'cursor' && group.tools.includes(tool) ? DRAWING_ICONS[tool] : group.icon;
  }

  /** The rail button shows the armed tool's group icon, or the group's own. */
  protected groupTooltip(group: ToolGroup): string {
    const tool = this.tool();
    return tool !== 'cursor' && group.tools.includes(tool)
      ? `${group.label}: ${DRAWING_LABELS[tool]}`
      : group.label;
  }

  protected onDrawingsChange(next: Drawing[]): void {
    this.drawings.set(next);
    this.persistDrawings(next);
  }

  protected onToolConsumed(): void {
    this.tool.set('cursor');
  }

  protected onSelectDrawing(id: string | null): void {
    this.selectedDrawingId.set(id);
  }

  protected toggleDrawingsPanel(): void {
    this.drawingsPanelOpen.update((open) => !open);
  }

  protected deleteDrawing(id: string): void {
    const next = this.drawings().filter((d) => d.id !== id);
    this.drawings.set(next);
    this.persistDrawings(next);
    if (this.selectedDrawingId() === id) this.selectedDrawingId.set(null);
  }

  protected clearDrawings(): void {
    if (this.drawings().length === 0) return;
    this.drawings.set([]);
    this.persistDrawings([]);
    this.selectedDrawingId.set(null);
  }

  private persistDrawings(drawings: Drawing[]): void {
    const instrument = this.instrument();
    if (!instrument) return;
    saveDrawings(this.isBrowser, instrument.id, this.timeframe(), drawings);
  }

  /**
   * A level's price is the only thing that distinguishes two of them in the
   * side panel, so the horizontal kinds carry it; everything else is named by
   * its tool.
   */
  protected drawingLabel(drawing: Drawing): string {
    const label = DRAWING_LABELS[drawing.kind];
    if (!LEVEL_KINDS.has(drawing.kind)) return label;
    const level = drawing.points[0]?.value;
    return level === undefined ? label : `${label} @ ${level.toFixed(2)}`;
  }

  // ---- indicators ----

  protected onIndicatorsChange(next: ReadonlySet<IndicatorKind>): void {
    this.activeIndicators.set(next);
    const instrument = this.instrument();
    if (!instrument) return;
    saveIndicators(this.isBrowser, instrument.id, this.timeframe(), [...next]);
  }

  // ---- AI analysis ----

  /**
   * Clears the displayed result, leaving any in-flight run alone.
   *
   * Deliberately not a cancel. A run is charged the moment it starts, so
   * changing the timeframe or the symbol while one is in flight used to throw
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
      lookbackDays: lookbackDaysFor(this.timeframe()),
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
      timeframeLabel: timeframeLabelFor(this.timeframe()),
    });

    const started = await this.live.startAnalysis(target.instrumentId, target.lookbackDays, chart);
    if (!started.ok) {
      this.runningFor.set(null);
      this.analyzeState.set(
        started.reason === 'insufficient_credits' ? 'insufficient_credits' : 'failed',
      );
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
}

/** Drawings whose whole meaning is one price, so the side panel prints it. */
const LEVEL_KINDS = new Set<DrawingKind>([
  'horizontalStraightLine',
  'horizontalRayLine',
  'horizontalSegment',
  'priceLine',
  'simpleTag',
]);

function lookbackDaysFor(timeframe: WorkspaceInterval): number {
  return TIMEFRAMES.find((t) => t.value === timeframe)?.lookbackDays ?? 365;
}

/** The timeframe's own short label, stamped onto the captured chart image and used in analysis-status copy. */
function timeframeLabelFor(timeframe: WorkspaceInterval): string | null {
  return TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? null;
}
