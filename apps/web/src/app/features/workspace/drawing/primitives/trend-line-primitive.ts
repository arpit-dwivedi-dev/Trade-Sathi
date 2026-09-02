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

import type { AnchorPoint } from '../drawing.types';
import { drawHandle, toPixel, type CanvasTarget, type PixelPoint } from './shared';

class TrendLineRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly p1: PixelPoint | null,
    private readonly p2: PixelPoint | null,
    private readonly color: string,
    private readonly selected: boolean,
  ) {}

  draw(target: CanvasTarget): void {
    const { p1, p2 } = this;
    if (!p1 || !p2) return;

    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      context.strokeStyle = this.color;
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(p1.x, p1.y);
      context.lineTo(p2.x, p2.y);
      context.stroke();

      if (this.selected) {
        drawHandle(context, p1, this.color);
        drawHandle(context, p2, this.color);
      }
      context.restore();
    });
  }
}

/**
 * A two-point trend line drawn between two {time, price} anchors. Attached to
 * the price series via `series.attachPrimitive`; the engine
 * (chart-drawing-engine.ts) owns anchor placement and dragging, this class
 * only owns rendering.
 */
export class TrendLinePrimitive implements ISeriesPrimitive<Time> {
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

  /** Called by the engine after mutating start/end (e.g. mid-drag) to force a repaint. */
  refresh(): void {
    this.requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [
      {
        renderer: (): IPrimitivePaneRenderer | null =>
          new TrendLineRenderer(
            toPixel(this.chart, this.series, this.start),
            toPixel(this.chart, this.series, this.end),
            this.color,
            this.selected,
          ),
      },
    ];
  }
}
