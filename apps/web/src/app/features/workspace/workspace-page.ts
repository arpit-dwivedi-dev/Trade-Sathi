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
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ChipModule } from 'primeng/chip';
import { Popover } from 'primeng/popover';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectButtonModule } from 'primeng/selectbutton';

import { type MarketTick } from '@tradesathi/shared';
import { AuthService } from '../../core/auth.service';
import { LiveService, type WorkspaceInterval } from '../../core/live.service';
import { MarketStreamService } from '../../core/market-stream.service';
import {
  clearPendingAnalysis,
  loadPendingAnalysis,
  savePendingAnalysis,
} from '../../core/pending-analysis-store';
import { AppIcon } from '../../shared/icons/app-icon';
import type { IconName } from '../../shared/icons/icon-paths';
import type { ReadyAnalysis } from '../../shared/analysis-ready-dialog/analysis-ready-dialog';
import type { ChartStyle, LiveCandle } from '../../shared/live-chart/live-chart';
import { ChartCaptureService } from '../../shared/live-chart/chart-capture.service';
import type { SymbolSelection } from '../../shared/symbol-search/symbol-search';
import { FAILURE_COPY, GENERIC_FAILURE } from '../analyze/analysis-result';
import { AnalyzeService, type PollHandle } from '../analyze/analyze.service';
import { BetaCredits } from '../billing/beta-credits';
import { PURCHASES_ENABLED } from '../billing/free-beta';
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
import { loadLastChart, saveLastChart } from './last-chart-store';
import { loadIndicators, saveIndicators } from './indicators/indicator-store';

/** The instrument shape both a search result and a candle-window response carry — see LiveService.fetchCandles. */
interface WorkspaceInstrument {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  /** Resolved server-side and often absent; see Instrument in @tradesathi/shared. */
  logoUrl?: string;
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
  /** Reopening a chart after a reload, while it is still unknown whether a run is going. */
  | 'restoring'
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
    AppIcon,
    BetaCredits,
    ButtonModule,
    ChipModule,
    DecimalPipe,
    FormsModule,
    IndicatorMenu,
    Popover,
    ProgressSpinnerModule,
    RouterLink,
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
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Raised when the user needs to buy more analyses — the shell opens plans. */
  readonly plansRequested = output<void>();

  /**
   * Raised when a run finishes, for the shell's "ready" dialog. Also raised
   * for a run that finished while the page was closed and was picked back up
   * on reload, which is the first chance there is to tell the user.
   */
  readonly analysisReady = output<ReadyAnalysis>();

  /**
   * Off for the free beta (see PURCHASES_ENABLED): the out-of-credits note
   * offers the beta code instead of a Buy button with nothing to sell.
   */
  protected readonly purchasesEnabled = PURCHASES_ENABLED;

  /**
   * Raised when this screen opened a chart on its own, from storage, after a
   * reload — the shell's search box owns the symbol label and has no other way
   * to learn what is on the chart.
   */
  readonly chartRestored = output<WorkspaceInstrument>();

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
  private readonly chartView = viewChild(WorkspaceChart);
  protected readonly downloading = signal(false);
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
  /** Calendar date (YYYY-MM-DD) of the newest candle on the chart — see CandleWindow.marketDataDate. */
  private readonly marketDataDate = signal<string | null>(null);
  /**
   * The session being shown when it is not today's — a weekend, a holiday, or
   * before the open. The API then serves the last trading session, and the
   * chart says which day that was rather than passing it off as live.
   */
  protected readonly closedSessionLabel = computed(() => {
    const date = this.marketDataDate();
    if (!date || date >= localIsoDate()) return null;
    return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  });

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

  /**
   * The last finished run's report, linked from a note under the chart.
   *
   * A result is never drawn on this screen: the report opens on its own page,
   * reached from the shell's "ready" dialog (see analysisReady). This note is
   * the way back to it once that dialog has been dismissed. It survives symbol
   * and timeframe switches, since a report does not depend on the chart on
   * screen, and gives way to the next run or to Dismiss.
   */
  protected readonly readyRun = signal<{ id: string; symbol: string } | null>(null);

  protected readonly busy = computed(
    () => this.analyzeState() === 'starting' || this.analyzeState() === 'processing',
  );

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
      this.restoreWorkspace();
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
    saveLastChart(this.isBrowser, { instrument, timeframe: this.timeframe() });
    this.chartError.set(null);
    this.clearStatus();
    void this.reload();
  }

  /** A logo URL that 404s leaves the space it occupied rather than reflowing the row. */
  protected onLogoError(event: Event): void {
    (event.target as HTMLImageElement).style.visibility = 'hidden';
  }

  protected selectTimeframe(value: WorkspaceInterval): void {
    if (value === this.timeframe()) return;
    this.timeframe.set(value);
    const instrument = this.instrument();
    if (instrument) saveLastChart(this.isBrowser, { instrument, timeframe: value });
    // A different timeframe is a different chart. Any run still in flight, and
    // the link to the last finished report, are deliberately left alone.
    this.clearStatus();
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
    this.marketDataDate.set(result.window.marketDataDate);
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
   * Clears a stale status line, leaving any in-flight run alone.
   *
   * Deliberately not a cancel. A run is charged the moment it starts, so
   * changing the timeframe or the symbol while one is in flight used to throw
   * away an analysis the user had already paid for — it completed server-side
   * and they never saw it. Now only the status is cleared; the run itself
   * keeps going and still announces itself when it finishes (see watchRun).
   */
  private clearStatus(): void {
    this.analyzeError.set(null);
    // A run still in flight keeps the view busy; only an idle view goes idle.
    if (!this.busy()) this.analyzeState.set('idle');
  }

  protected dismissReady(): void {
    this.readyRun.set(null);
  }

  /** Saves the chart on screen — indicators and drawings included — as a high-resolution PNG. */
  protected async downloadChart(): Promise<void> {
    const instrument = this.instrument();
    const chart = this.chartView();
    if (!instrument || !chart || this.downloading()) return;

    this.downloading.set(true);
    try {
      const image = await chart.exportImage({
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        timeframeLabel: timeframeLabelFor(this.timeframe()),
      });
      if (!image) return;

      const url = URL.createObjectURL(image);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${instrument.symbol}-${this.timeframe()}-${localIsoDate()}.png`;
      link.click();
      // Revoked on the next task: the click has started the download by then.
      setTimeout(() => URL.revokeObjectURL(url));
    } finally {
      this.downloading.set(false);
    }
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

    this.clearStatus();
    // The new run's report replaces the old one's link when it finishes.
    this.readyRun.set(null);
    this.analyzeState.set('starting');

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
      this.analyzeState.set(
        started.reason === 'insufficient_credits' ? 'insufficient_credits' : 'failed',
      );
      this.analyzeError.set(started.message);
      return;
    }

    // Remembered before the wait starts, so a reload mid-run can pick the same
    // row back up instead of losing a run that is already charged and running.
    savePendingAnalysis(this.isBrowser, 'workspace', {
      id: started.analysisId,
      startedAt: Date.now(),
      chart: {
        instrument: {
          id: instrument.id,
          symbol: instrument.symbol,
          name: instrument.name,
          exchange: instrument.exchange,
          logoUrl: instrument.logoUrl,
        },
        timeframe: this.timeframe(),
        lookbackDays: target.lookbackDays,
      },
    });

    await this.watchRun(started.analysisId, target);
  }

  /**
   * Waits for one run to settle, then announces it: a finished run through the
   * shell's "ready" dialog (the report opens on its own page, never here), a
   * failed one as a status line naming its symbol.
   *
   * Shared by a run started here and one resumed after a reload: both are just
   * an analyses row id plus the chart it belongs to, and neither cares which
   * page load started it. The symbol on screen by then does not matter either:
   * the run is announced under the symbol it was started for.
   */
  private async watchRun(analysisId: string, target: AnalysisTarget): Promise<void> {
    this.analyzeState.set('processing');
    // Watched by row id, so a run that fails reports 'failed' as soon as the
    // pipeline records it rather than after a three-minute client timeout.
    const handle = this.analyses.pollAnalysis(analysisId, () => {
      /* Intermediate states are not rendered here; only the outcome matters. */
    });
    this.pending = handle;

    const outcome = await handle.result;
    if (this.pending !== handle) return;
    this.pending = null;

    // Only a settled run stops being remembered. 'timed_out' means the backend
    // may still be working on it, and 'poll_error' means this browser could not
    // read the row — neither says the run is over, so both stay resumable.
    if (outcome.outcome === 'complete' || outcome.outcome === 'failed') {
      clearPendingAnalysis(this.isBrowser, 'workspace');
    }

    if (outcome.outcome === 'complete') {
      this.analyzeState.set('complete');
      const ready = { id: outcome.row.id, symbol: target.symbol };
      this.readyRun.set(ready);
      this.analysisReady.emit({ ...ready, kind: 'chart' });
      return;
    }

    if (outcome.outcome === 'failed') {
      this.analyzeState.set('failed');
      // Named, because the user may be looking at another symbol by now.
      const code = outcome.row.error_code;
      this.analyzeError.set(
        `${target.symbol}: ${(code && FAILURE_COPY[code]) || GENERIC_FAILURE}`,
      );
      return;
    }

    this.analyzeState.set('failed');
    this.analyzeError.set(
      outcome.outcome === 'timed_out'
        ? "This is taking longer than expected. If it finished, it'll be in your history."
        : 'Could not read the finished analysis. Check your connection and try again.',
    );
  }

  /**
   * Puts the workspace back the way the user left it after a reload.
   *
   * Two things are restored, and neither survives a page load on its own: the
   * chart (the instrument comes from the shell's search as an input, which
   * starts null every load) and any analysis still running on it (charged and
   * executed server-side the moment it starts, so it must not look like
   * nothing is happening).
   *
   * Anything the shell hands down afterwards still wins — the selection effect
   * in the constructor calls openInstrument in its own right.
   */
  private restoreWorkspace(): void {
    const pending = loadPendingAnalysis(this.isBrowser, 'workspace');
    const last = loadLastChart(this.isBrowser);
    const chart = pending?.chart ?? last;
    if (!chart) return;

    // A stored timeframe this build no longer offers falls back to the default
    // rather than charting an interval the API would reject.
    this.timeframe.set(
      TIMEFRAMES.find((t) => t.value === chart.timeframe)?.value ?? DEFAULT_TIMEFRAME,
    );
    this.openInstrument(chart.instrument);
    this.chartRestored.emit(chart.instrument);

    // After openInstrument, whose clearStatus() would otherwise put this back
    // to idle, and still before the first paint. A remembered run is known to
    // be going; without one it is not known yet, and 'restoring' keeps the
    // Analyse button disabled — without claiming an analysis is running — until
    // adoptUnfinishedRun settles the question.
    this.analyzeState.set(pending ? 'processing' : 'restoring');

    // Awaited rather than read straight away: on a fresh page load the Supabase
    // session is restored asynchronously, and a read issued before it lands is
    // refused by RLS — which would look like a run that cannot be read when
    // nothing is wrong with it.
    void this.auth.whenRestored().then(() => {
      if (pending?.chart) {
        return this.watchRun(pending.id, {
          instrumentId: pending.chart.instrument.id,
          symbol: pending.chart.instrument.symbol,
          lookbackDays: pending.chart.lookbackDays,
        });
      }
      return this.adoptUnfinishedRun(chart.instrument);
    });
  }

  /**
   * Re-attaches to a run this browser never got to remember.
   *
   * The row is created server-side before /api/market/analyze has even
   * responded, so a refresh in that window — the most likely moment for one,
   * since the user has just clicked and is watching — leaves a charged run with
   * no local record. The database is the authority on what is still running, so
   * it is asked directly.
   */
  private async adoptUnfinishedRun(instrument: WorkspaceInstrument): Promise<void> {
    const row = await this.analyses.findUnfinishedAnalysis(instrument.id, 'live');
    // The user may have started a run of their own, or moved on to another
    // symbol, while this was read.
    if (this.busy() || this.instrument()?.id !== instrument.id) return;
    if (!row) {
      // Nothing running: release the button restoreWorkspace held disabled.
      if (this.analyzeState() === 'restoring') this.analyzeState.set('idle');
      return;
    }

    const lookbackDays = row.analysis_lookback_days ?? lookbackDaysFor(this.timeframe());
    savePendingAnalysis(this.isBrowser, 'workspace', {
      id: row.id,
      startedAt: Date.parse(row.created_at) || Date.now(),
      chart: { instrument, timeframe: this.timeframe(), lookbackDays },
    });

    await this.watchRun(row.id, {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      lookbackDays,
    });
  }

  protected openPlans(): void {
    this.plansRequested.emit();
  }

  /** The beta code was redeemed from the out-of-credits note, so Analyze is worth pressing again. */
  protected onBetaRedeemed(): void {
    if (this.analyzeState() !== 'insufficient_credits') return;
    this.analyzeState.set('idle');
    this.analyzeError.set(null);
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
/** Today's date in the viewer's own timezone, as YYYY-MM-DD. */
function localIsoDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function timeframeLabelFor(timeframe: WorkspaceInterval): string | null {
  return TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? null;
}
