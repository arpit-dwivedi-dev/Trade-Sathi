import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  PLATFORM_ID,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IPaneApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type Time,
} from 'lightweight-charts';

import { ThemeService } from '../../../core/theme.service';
import {
  applyCandles,
  chartOptions,
  createCandleChart,
  readPalette,
  updateLastCandle,
  type CandleChart,
  type ChartOverlays,
  type ChartPalette,
  type LiveCandle,
} from '../../../shared/live-chart/chart-render';
import { ChartDrawingEngine } from '../drawing/chart-drawing-engine';
import type { Drawing, DrawTool } from '../drawing/drawing.types';
import type { IndicatorKind } from '../indicators/indicator-menu';
import { bollingerBands, ema, macd, rsi, sma } from '../indicators/indicators';

/** Fixed per-indicator colours — distinct from the candle up/down palette and from each other, same in both themes. */
const INDICATOR_COLORS: Record<IndicatorKind, string> = {
  sma: '#2563eb',
  ema: '#f59e0b',
  bollinger: '#8b5cf6',
  rsi: '#0ea5e9',
  macd: '#2563eb',
};

const REF_LINE_COLOR = 'rgba(148, 163, 184, 0.6)';

interface IndicatorHandle {
  /** Sub-pane indicators (RSI/MACD) get their own pane; overlay ones (SMA/EMA/Bollinger) sit in pane 0 with the candles. */
  pane: IPaneApi<Time> | null;
  series: ISeriesApi<SeriesType, Time>[];
}

/**
 * The manual analysis workspace's chart: reuses the same base candle+volume
 * renderer as the read-only Live tab chart (`shared/live-chart/chart-render`)
 * so the two look identical, then layers on what the workspace adds —
 * indicator series/panes and the pointer-driven drawing tools
 * (see ChartDrawingEngine).
 */
@Component({
  selector: 'app-workspace-chart',
  templateUrl: './workspace-chart.html',
  styleUrl: './workspace-chart.css',
})
export class WorkspaceChart implements OnDestroy {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly themeService = inject(ThemeService);

  readonly candles = input<LiveCandle[]>([]);
  readonly overlays = input<ChartOverlays | null>(null);
  readonly activeIndicators = input<ReadonlySet<IndicatorKind>>(new Set());
  readonly tool = input<DrawTool>('cursor');
  readonly drawings = input<Drawing[]>([]);

  /** Emitted whenever a drawing is placed, dragged, or (by the host, on delete) removed — the host persists it. */
  readonly drawingsChange = output<Drawing[]>();
  /** Emitted once a placement finishes or is cancelled — the host flips the active tool back to 'cursor'. */
  readonly toolConsumed = output<void>();
  readonly selectedDrawingId = output<string | null>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('container');

  private target: CandleChart | null = null;
  private appliedSignature: string | null = null;
  private priceLines: IPriceLine[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private engine: ChartDrawingEngine | null = null;
  private readonly indicatorState = new Map<IndicatorKind, IndicatorHandle>();

  constructor() {
    // Candles and theme are separate effects on purpose — see LiveChart, whose
    // pattern this mirrors: a theme toggle must not reset pan/zoom, and new
    // candles must not repaint colours.
    effect(() => {
      const candles = this.candles();
      if (!this.isBrowser) return;
      this.ensureChart();
      const target = this.target;
      if (!target) return;

      const signature = seriesSignature(candles);
      const last = candles[candles.length - 1];
      if (last && signature === this.appliedSignature) {
        updateLastCandle(target, last, this.palette());
      } else {
        applyCandles(target, candles, this.palette());
        this.appliedSignature = signature;
      }
      this.syncIndicators();
    });

    effect(() => {
      const overlays = this.overlays();
      if (!this.isBrowser) return;
      this.ensureChart();
      this.drawOverlays(overlays);
    });

    effect(() => {
      const theme = this.themeService.theme();
      if (!this.isBrowser || !this.target) return;
      void theme;
      this.target.chart.applyOptions(chartOptions(this.palette()));
    });

    effect(() => {
      const tool = this.tool();
      this.engine?.setTool(tool);
    });

    effect(() => {
      const drawings = this.drawings();
      this.engine?.sync(drawings);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.engine?.dispose();
    this.engine = null;
    for (const handle of this.indicatorState.values()) this.teardownHandle(handle);
    this.indicatorState.clear();
    this.target?.chart.remove();
    this.target = null;
    this.priceLines = [];
  }

  private palette(): ChartPalette {
    return readPalette(this.host().nativeElement);
  }

  private ensureChart(): void {
    if (this.target) return;
    const element = this.host().nativeElement;

    this.target = createCandleChart(element, this.palette(), {
      width: element.clientWidth,
      height: element.clientHeight,
    });
    // The price+volume pane dominates; any indicator sub-panes added later default to a smaller share.
    this.target.chart.panes()[0]?.setStretchFactor(4);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.target) return;
      this.target.chart.resize(element.clientWidth, element.clientHeight);
    });
    this.resizeObserver.observe(element);

    this.engine = new ChartDrawingEngine(this.target.chart, this.target.priceSeries, element, {
      onDrawingsChange: (drawings) => this.drawingsChange.emit(drawings),
      onPlaced: () => this.toolConsumed.emit(),
      onSelect: (id) => this.selectedDrawingId.emit(id),
    });
    this.engine.setTool(this.tool());
    this.engine.sync(this.drawings());
  }

  private drawOverlays(overlays: ChartOverlays | null): void {
    const series = this.target?.priceSeries;
    if (!series) return;

    for (const line of this.priceLines) series.removePriceLine(line);
    this.priceLines = [];
    if (!overlays) return;

    const palette = this.palette();
    const add = (price: number, title: string, color: string, dashed: boolean): void => {
      this.priceLines.push(
        series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title,
        }),
      );
    };

    for (const level of overlays.support) add(level, 'S', palette.up, false);
    for (const level of overlays.resistance) add(level, 'R', palette.down, false);
    if (overlays.entry !== null) add(overlays.entry, 'Entry', palette.accent, true);
    if (overlays.target !== null) add(overlays.target, 'Target', palette.up, true);
    if (overlays.invalidation !== null) add(overlays.invalidation, 'Stop', palette.down, true);
  }

  // ---- indicators ----

  private syncIndicators(): void {
    const target = this.target;
    if (!target) return;
    const active = this.activeIndicators();
    const candles = this.candles();

    for (const kind of Object.keys(INDICATOR_COLORS) as IndicatorKind[]) {
      const wants = active.has(kind);
      const existing = this.indicatorState.get(kind);

      if (!wants) {
        if (existing) {
          this.teardownHandle(existing);
          this.indicatorState.delete(kind);
        }
        continue;
      }

      const handle = existing ?? this.createIndicator(target, kind);
      if (!existing) this.indicatorState.set(kind, handle);
      this.updateIndicatorData(kind, handle, candles);
    }
  }

  private createIndicator(target: CandleChart, kind: IndicatorKind): IndicatorHandle {
    const { chart } = target;
    const color = INDICATOR_COLORS[kind];
    const baseOptions = { lineWidth: 2 as const, priceLineVisible: false, lastValueVisible: false };

    if (kind === 'sma' || kind === 'ema') {
      const line = chart.addSeries(LineSeries, { ...baseOptions, color });
      return { pane: null, series: [line] };
    }

    if (kind === 'bollinger') {
      const basis = chart.addSeries(LineSeries, { ...baseOptions, lineWidth: 1, color });
      const upper = chart.addSeries(LineSeries, { ...baseOptions, lineWidth: 1, color: `${color}99` });
      const lower = chart.addSeries(LineSeries, { ...baseOptions, lineWidth: 1, color: `${color}99` });
      return { pane: null, series: [basis, upper, lower] };
    }

    // rsi / macd: each gets its own sub-pane below the price+volume pane.
    const pane = chart.addPane();
    pane.setStretchFactor(1.3);
    const paneIndex = pane.paneIndex();

    if (kind === 'rsi') {
      const line = chart.addSeries(LineSeries, { ...baseOptions, color }, paneIndex);
      const refLine = { color: REF_LINE_COLOR, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' };
      line.createPriceLine({ price: 70, ...refLine });
      line.createPriceLine({ price: 30, ...refLine });
      return { pane, series: [line] };
    }

    const histogram = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex);
    const macdLine = chart.addSeries(LineSeries, { ...baseOptions, color }, paneIndex);
    const signalLine = chart.addSeries(LineSeries, { ...baseOptions, lineWidth: 1, color: '#f59e0b' }, paneIndex);
    return { pane, series: [histogram, macdLine, signalLine] };
  }

  private updateIndicatorData(kind: IndicatorKind, handle: IndicatorHandle, candles: LiveCandle[]): void {
    if (kind === 'sma') {
      handle.series[0].setData(sma(candles));
      return;
    }
    if (kind === 'ema') {
      handle.series[0].setData(ema(candles));
      return;
    }
    if (kind === 'bollinger') {
      const points = bollingerBands(candles);
      handle.series[0].setData(points.map((p) => ({ time: p.time, value: p.basis })));
      handle.series[1].setData(points.map((p) => ({ time: p.time, value: p.upper })));
      handle.series[2].setData(points.map((p) => ({ time: p.time, value: p.lower })));
      return;
    }
    if (kind === 'rsi') {
      handle.series[0].setData(rsi(candles));
      return;
    }

    const palette = this.palette();
    const points = macd(candles);
    handle.series[0].setData(
      points.map((p) => ({ time: p.time, value: p.histogram, color: p.histogram >= 0 ? palette.up : palette.down })),
    );
    handle.series[1].setData(points.map((p) => ({ time: p.time, value: p.macd })));
    handle.series[2].setData(points.map((p) => ({ time: p.time, value: p.signal })));
  }

  private teardownHandle(handle: IndicatorHandle): void {
    const target = this.target;
    if (!target) return;
    for (const series of handle.series) target.chart.removeSeries(series);
    if (handle.pane) target.chart.removePane(handle.pane.paneIndex());
  }
}

/**
 * A cheap identity for a drawn series. Deliberately ignores prices — see the
 * identical helper on LiveChart, which this mirrors.
 */
function seriesSignature(candles: LiveCandle[]): string {
  if (candles.length === 0) return '0';
  return `${candles.length}|${candles[0].timestamp}|${candles[candles.length - 1].timestamp}`;
}
