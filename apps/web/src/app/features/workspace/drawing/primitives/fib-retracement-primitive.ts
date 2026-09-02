import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

import { FIB_LEVELS, type AnchorPoint } from '../drawing.types';
import { drawHandle, toPixel, type CanvasTarget, type PixelPoint } from './shared';

class FibRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly p1: PixelPoint | null,
    private readonly p2: PixelPoint | null,
    private readonly startPrice: number,
    private readonly endPrice: number,
    // Goes through the series rather than interpolating p1.y/p2.y directly so
    // a log price scale (non-linear price-to-pixel mapping) still places each
    // level correctly.
    private readonly priceToY: (price: number) => number | null,
    private readonly color: string,
    private readonly selected: boolean,
  ) {}

  draw(target: CanvasTarget): void {
    const { p1, p2 } = this;
    if (!p1 || !p2) return;
    const left = Math.min(p1.x, p2.x);
    const right = Math.max(p1.x, p2.x);
    const diff = this.endPrice - this.startPrice;

    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      context.strokeStyle = this.color;
      context.fillStyle = this.color;
      context.font = '11px sans-serif';
      context.lineWidth = 1;

      for (const level of FIB_LEVELS) {
        const price = this.startPrice + diff * level;
        const y = this.priceToY(price);
        if (y === null) continue;

        context.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
        context.setLineDash([]);
        context.fillText(`${(level * 100).toFixed(1)}%  ${price.toFixed(2)}`, left + 4, y - 3);
      }

      if (this.selected) {
        drawHandle(context, p1, this.color);
        drawHandle(context, p2, this.color);
      }
      context.restore();
    });
  }
}

/**
 * A Fibonacci retracement drawn between two {time, price} anchors: the
 * standard ratio lines (0/23.6/38.2/50/61.8/78.6/100%) spanning the anchors'
 * time range, each labelled with its price. Attached to the price series via
 * `series.attachPrimitive`.
 */
export class FibRetracementPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;

  constructor(
    public start: AnchorPoint,
    public end: AnchorPoint,
    private color: string,
    public selected = false,
  ) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setColor(color: string): void {
    this.color = color;
  }

  setSelected(selected: boolean): void {
    this.selected = selected;
  }

  refresh(): void {
    this.requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [
      {
        renderer: (): IPrimitivePaneRenderer | null =>
          new FibRenderer(
            toPixel(this.chart, this.series, this.start),
            toPixel(this.chart, this.series, this.end),
            this.start.price,
            this.end.price,
            (price) => this.series?.priceToCoordinate(price) ?? null,
            this.color,
            this.selected,
          ),
      },
    ];
  }
}

export type { AnchorPoint };
