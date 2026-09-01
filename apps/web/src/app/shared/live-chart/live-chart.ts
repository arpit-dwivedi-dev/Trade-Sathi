import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  PLATFORM_ID,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { LineStyle, type IPriceLine } from 'lightweight-charts';

import { ThemeService } from '../../core/theme.service';
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
} from './chart-render';

// Re-exported so the many call sites that already import these from the
// component keep working; they are defined next to the drawing code they
// describe, which the off-screen renderer shares.
export type { ChartOverlays, LiveCandle };

/**
 * An interactive candlestick chart (TradingView lightweight-charts, Apache-2.0).
 *
 * Presentational: it renders whatever candles and overlay levels it is given
 * and owns no fetching. The chart library touches `window`/`document` at
 * construction, so every call into it is guarded to the browser — during SSR
 * this renders an empty container and the client builds the real chart on
 * hydration.
 */
@Component({
  selector: 'app-live-chart',
  templateUrl: './live-chart.html',
  styleUrl: './live-chart.css',
})
export class LiveChart implements OnDestroy {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly themeService = inject(ThemeService);

  readonly candles = input<LiveCandle[]>([]);
  readonly overlays = input<ChartOverlays | null>(null);
  /** e.g. "1D · 90d"; shown as the chart's own caption. */
  readonly timeframeLabel = input<string | null>(null);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('container');

  private target: CandleChart | null = null;
  /**
   * Identifies the series currently drawn — its length and its end
   * timestamps. Unchanged between two renders means the same candles are on
   * screen and only the newest one's price moved, which is the incremental
   * path; anything else is a new window and gets redrawn whole.
   */
  private appliedSignature: string | null = null;
  private priceLines: IPriceLine[] = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    // Data and theme are separate effects on purpose: a theme toggle must not
    // reset the user's pan/zoom, and new candles must not repaint colours.
    effect(() => {
      const candles = this.candles();
      if (!this.isBrowser) return;
      this.ensureChart();
      if (!this.target) return;

      const signature = seriesSignature(candles);
      const last = candles[candles.length - 1];
      if (last && signature === this.appliedSignature) {
        updateLastCandle(this.target, last, this.palette());
        return;
      }
      applyCandles(this.target, candles, this.palette());
      this.appliedSignature = signature;
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
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.target?.chart.remove();
    this.target = null;
    this.priceLines = [];
  }

  /** Colours read from the same CSS tokens the rest of the app uses, so the
   *  chart follows a theme change (and any future palette edit) for free. */
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

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.target) return;
      this.target.chart.resize(element.clientWidth, element.clientHeight);
    });
    this.resizeObserver.observe(element);
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
}

/**
 * A cheap identity for a drawn series. Deliberately ignores prices: a live
 * tick only ever changes the newest candle's OHLC, never which candles are on
 * screen, so prices must not be part of what decides "same series".
 */
function seriesSignature(candles: LiveCandle[]): string {
  if (candles.length === 0) return '0';
  return `${candles.length}|${candles[0].timestamp}|${candles[candles.length - 1].timestamp}`;
}
