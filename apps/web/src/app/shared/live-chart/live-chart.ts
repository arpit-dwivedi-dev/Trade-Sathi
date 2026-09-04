import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  PLATFORM_ID,
  effect,
  inject,
  input,
  untracked,
  viewChild,
} from '@angular/core';

import { ThemeService } from '../../core/theme.service';
import {
  applyCandles,
  applyPalette,
  createCandleChart,
  disposeCandleChart,
  drawLevelOverlays,
  readPalette,
  updateLastCandle,
  type CandleChart,
  type ChartOverlays,
  type OverlayBand,
  type ChartPalette,
  type LiveCandle,
} from './chart-render';

// Re-exported so the many call sites that already import these from the
// component keep working; they are defined next to the drawing code they
// describe, which the off-screen renderer shares.
export type { ChartOverlays, LiveCandle, OverlayBand };

/**
 * An interactive candlestick chart (KLineChart, Apache-2.0).
 *
 * Presentational: it renders whatever candles and overlay levels it is given
 * and owns no fetching. The chart library reads `window` at module scope, so
 * it is imported lazily and only from the browser — during SSR this renders an
 * empty container and the client builds the real chart on hydration.
 *
 * That lazy import is why the chart is reached through `withChart` rather than
 * held in a field the effects can touch directly: construction is asynchronous,
 * and effects can fire several times before it finishes. Queuing them onto the
 * one construction promise keeps them in order without any of them having to
 * know whether the chart exists yet.
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

  private chartReady: Promise<CandleChart> | null = null;
  private target: CandleChart | null = null;
  private destroyed = false;
  /**
   * Identifies the series currently drawn — its length and its end
   * timestamps. Unchanged between two renders means the same candles are on
   * screen and only the newest one's price moved, which is the incremental
   * path; anything else is a new window and gets redrawn whole.
   */
  private appliedSignature: string | null = null;

  constructor() {
    // Data and theme are separate effects on purpose: a theme toggle must not
    // reset the user's pan/zoom, and new candles must not repaint colours.
    effect(() => {
      const candles = this.candles();
      if (!this.isBrowser) return;
      this.withChart((target) => {
        const signature = seriesSignature(candles);
        const last = candles[candles.length - 1];
        if (last && signature === this.appliedSignature) {
          updateLastCandle(target, last);
          return;
        }
        applyCandles(target, candles);
        this.appliedSignature = signature;
      });
    });

    effect(() => {
      const overlays = this.overlays();
      if (!this.isBrowser) return;
      this.withChart((target) => drawLevelOverlays(target, overlays, this.palette()));
    });

    effect(() => {
      const theme = this.themeService.theme();
      if (!this.isBrowser) return;
      void theme;
      this.withChart((target) => applyPalette(target, this.palette()));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.target) disposeCandleChart(this.target);
    this.target = null;
  }

  /** Colours read from the same CSS tokens the rest of the app uses, so the
   *  chart follows a theme change (and any future palette edit) for free. */
  private palette(): ChartPalette {
    return readPalette(this.host().nativeElement);
  }

  /**
   * Runs `fn` against the chart, building it first if this is the first call.
   * Callbacks queue on the one construction promise, so they run in the order
   * their effects fired, and none of them runs after the component is gone.
   */
  private withChart(fn: (target: CandleChart) => void): void {
    this.chartReady ??= this.createChart();
    void this.chartReady.then(
      (target) => {
        if (!this.destroyed) fn(target);
      },
      (cause: unknown) => {
        console.warn('live chart could not be created', cause);
      },
    );
  }

  private async createChart(): Promise<CandleChart> {
    const element = this.host().nativeElement;
    const candles = untracked(this.candles);
    const target = await createCandleChart(element, this.palette(), candles);

    // The component can be torn down while the library is still downloading.
    if (this.destroyed) {
      disposeCandleChart(target);
      throw new Error('live chart destroyed before it finished loading');
    }

    // createCandleChart seeded the feed with these, so the first queued
    // callback must see them as already drawn rather than reloading.
    this.target = target;
    this.appliedSignature = seriesSignature(candles);
    return target;
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
