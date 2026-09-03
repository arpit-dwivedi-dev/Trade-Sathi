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
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import { type MarketTick } from '@chartanalyzer/shared';
import { LiveService, type WorkspaceInterval } from '../live/live.service';
import { MarketStreamService } from '../live/market-stream.service';
import type { LiveCandle } from '../../shared/live-chart/live-chart';
import type { SymbolSelection } from '../../shared/symbol-search/symbol-search';
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

const INTRADAY_REFRESH_MS = 30_000;
const DAILY_REFRESH_MS = 5 * 60_000;
const STREAMING_INTRADAY_REFRESH_MS = 2 * 60_000;
const ROLLOVER_REFETCH_MIN_GAP_MS = 5_000;

/**
 * The manual analysis workspace: a tab in the dashboard shell (not a
 * separate route) for picking an instrument, switching candle timeframe, and
 * drawing on the chart — separate from the AI "Analyse this chart" pipeline,
 * which this screen does not touch. Reached via the nav rail's own tab entry
 * or the Live tab's "Manual Analysis" button, the latter handing off the
 * symbol already on screen there via `selection` (see AppPage).
 *
 * The instrument itself is not picked here: the shell's top-bar search owns
 * that for every chart tab, and hands the choice down through `selection`.
 *
 * Staying a tab rather than its own route is deliberate: the dashboard nav
 * rail stays visible by default so the workspace never opens onto a blank,
 * disorienting screen. `toggleSidebar` and the real Fullscreen API (see
 * toggleFullscreen) are what let a user reclaim that space on their own
 * terms instead of it being taken from them automatically.
 *
 * The candle-poll + live-tick-merge logic below is deliberately a close
 * cousin of LivePage's, not a shared service — see the workspace plan's
 * "deliberate scope cuts" for why (avoiding touching that already-working
 * screen outweighs the ~60 lines of duplication here).
 */
@Component({
  selector: 'app-workspace-page',
  imports: [
    DecimalPipe,
    IndicatorMenu,
    MatButtonModule,
    MatButtonToggleModule,
    MatChipsModule,
    MatIconModule,
    MatMenuModule,
    WorkspaceChart,
  ],
  templateUrl: './workspace-page.html',
  styleUrl: './workspace-page.css',
})
export class WorkspacePage implements OnInit, OnDestroy {
  private readonly live = inject(LiveService);
  private readonly stream = inject(MarketStreamService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * The instrument to chart, chosen in the shell's top-bar search (or handed
   * off by Live's "Manual Analysis" button with the symbol already on screen
   * there). This screen has no search box of its own.
   */
  readonly selection = input<SymbolSelection | null>(null);
  /** Raised by the "Collapse sidebar" control — AppPage owns the rail, this only asks. */
  readonly toggleSidebar = output<void>();

  protected readonly timeframes = TIMEFRAMES;
  protected readonly toolGroups = TOOL_GROUPS;

  private readonly shellHost = viewChild<ElementRef<HTMLDivElement>>('shell');
  /** True while this screen (not the whole document) is Fullscreen-API-fullscreen. */
  protected readonly isFullscreen = signal(false);

  protected readonly instrument = signal<WorkspaceInstrument | null>(null);

  protected readonly timeframe = signal<WorkspaceInterval>(DEFAULT_TIMEFRAME);
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

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopStream: (() => void) | null = null;
  private lastRolloverFetchAt = 0;
  private intervalMinutes = 0;
  /** Guards a slow fetch for an abandoned symbol/timeframe from painting over the current one. */
  private requestSeq = 0;

  constructor() {
    // Re-arms the poll cadence whenever streaming connects/drops, exactly
    // like LivePage — see its constructor for why this lives in an effect.
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
    // the live price stream: fail quietly, the collapse-sidebar control
    // still gets most of the same room back.
    this.shellHost()
      ?.nativeElement.requestFullscreen()
      .catch(() => {
        /* not fatal — see above */
      });
  }

  protected requestCollapseSidebar(): void {
    this.toggleSidebar.emit();
  }

  /**
   * Charts an instrument handed down from the shell. Same symbol as the one
   * already open is still honoured — it is how a stale error state or a
   * dropped stream gets reset.
   */
  private openInstrument(instrument: WorkspaceInstrument): void {
    this.instrument.set(instrument);
    this.chartError.set(null);
    void this.reload();
  }

  protected selectTimeframe(value: WorkspaceInterval): void {
    if (value === this.timeframe()) return;
    this.timeframe.set(value);
    void this.reload();
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

  /** Folds one streamed price into the view — see LivePage.applyTick, which this mirrors exactly. */
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
   * matMenuContent hands its context through untyped, so the label lookup
   * goes through a typed method rather than indexing the record from the
   * template.
   */
  protected toolLabel(kind: DrawingKind): string {
    return DRAWING_LABELS[kind];
  }

  /** Same lookup, same reason — the flyout's per-tool glyph. */
  protected toolIcon(kind: DrawingKind): string {
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
  protected groupIcon(group: ToolGroup): string {
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
