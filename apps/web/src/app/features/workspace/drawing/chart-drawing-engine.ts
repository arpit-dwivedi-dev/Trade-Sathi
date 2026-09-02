import { LineStyle, type IChartApi, type IPriceLine, type ISeriesApi } from 'lightweight-charts';

import {
  newDrawingId,
  type AnchorPoint,
  type Drawing,
  type DrawTool,
  type FibDrawing,
  type HorizontalLineDrawing,
  type TrendLineDrawing,
} from './drawing.types';
import { FibRetracementPrimitive } from './primitives/fib-retracement-primitive';
import { toPixel, type PixelPoint } from './primitives/shared';
import { TrendLinePrimitive } from './primitives/trend-line-primitive';

export interface DrawingEngineCallbacks {
  /** A drawing was placed, moved, or (elsewhere) deleted — persist this set. */
  onDrawingsChange: (drawings: Drawing[]) => void;
  /** A placement finished or was cancelled — the host flips the active tool back to 'cursor'. */
  onPlaced: () => void;
  /** The user clicked a drawing (select) or empty space while one was selected (deselect). */
  onSelect: (id: string | null) => void;
}

const HIT_TOLERANCE_PX = 8;

type DragState = { kind: 'horizontal'; id: string } | { kind: 'point'; id: string; anchor: 'start' | 'end' };
type LinePrimitive = TrendLinePrimitive | FibRetracementPrimitive;

/**
 * Pointer-driven drawing tool engine for the workspace chart. Owns placing,
 * dragging, and rendering trendlines/horizontal lines/Fibonacci retracements
 * on top of the price series — the host component only feeds it the active
 * tool and the current drawing set, and reacts to its callbacks to persist.
 *
 * Horizontal lines are the series' own native price lines (draggable via
 * `IPriceLine.applyOptions({price})`, no custom rendering needed). Trendlines
 * and Fibonacci retracements have no native equivalent and are rendered via
 * `ISeriesPrimitive`s attached to the price series.
 *
 * While a tool other than 'cursor' is placing a drawing, or while an existing
 * drawing is being dragged, the chart's own pan/zoom (`handleScroll`/
 * `handleScale`) is switched off so the two interactions cannot both react to
 * the same pointer gesture; it is restored the moment the drawing completes.
 */
export class ChartDrawingEngine {
  private drawings: Drawing[] = [];
  private tool: DrawTool = 'cursor';
  private selectedId: string | null = null;
  private color = '#4f46e5';

  private readonly priceLines = new Map<string, IPriceLine>();
  private readonly primitives = new Map<string, LinePrimitive>();

  private pendingStart: AnchorPoint | null = null;
  private previewPrimitive: LinePrimitive | null = null;
  private drag: DragState | null = null;

  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<'Candlestick'>,
    private readonly container: HTMLElement,
    private readonly callbacks: DrawingEngineCallbacks,
  ) {
    this.container.addEventListener('pointerdown', this.onPointerDown);
    this.container.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.cancelPending();
    for (const id of [...this.priceLines.keys(), ...this.primitives.keys()]) this.removeVisual(id);
  }

  setColor(color: string): void {
    this.color = color;
  }

  setTool(tool: DrawTool): void {
    if (this.tool === tool) return;
    this.cancelPending();
    this.tool = tool;
    this.chart.applyOptions({ handleScroll: tool === 'cursor', handleScale: tool === 'cursor' });
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    for (const [drawingId, primitive] of this.primitives) {
      primitive.setSelected(drawingId === id);
      primitive.refresh();
    }
  }

  /** Replaces the whole drawing set — called on load, on a timeframe/instrument switch, or after an external delete. */
  sync(drawings: Drawing[]): void {
    this.drawings = drawings;
    const keep = new Set(drawings.map((d) => d.id));
    for (const id of [...this.priceLines.keys(), ...this.primitives.keys()]) {
      if (!keep.has(id)) this.removeVisual(id);
    }
    for (const drawing of drawings) this.upsert(drawing);
  }

  private upsert(drawing: Drawing): void {
    if (drawing.kind === 'horizontal') {
      this.upsertHorizontal(drawing);
    } else {
      this.upsertLine(drawing);
    }
  }

  private upsertHorizontal(drawing: HorizontalLineDrawing): void {
    const existing = this.priceLines.get(drawing.id);
    if (existing) {
      existing.applyOptions({ price: drawing.price });
      return;
    }
    const line = this.series.createPriceLine({
      price: drawing.price,
      color: this.color,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: 'S/R',
    });
    this.priceLines.set(drawing.id, line);
  }

  private upsertLine(drawing: TrendLineDrawing | FibDrawing): void {
    const existing = this.primitives.get(drawing.id);
    if (existing) {
      existing.start = drawing.start;
      existing.end = drawing.end;
      existing.refresh();
      return;
    }
    const primitive: LinePrimitive =
      drawing.kind === 'trendline'
        ? new TrendLinePrimitive(drawing.start, drawing.end, this.color, drawing.id === this.selectedId)
        : new FibRetracementPrimitive(drawing.start, drawing.end, this.color, drawing.id === this.selectedId);
    this.series.attachPrimitive(primitive);
    this.primitives.set(drawing.id, primitive);
  }

  private removeVisual(id: string): void {
    const line = this.priceLines.get(id);
    if (line) {
      this.series.removePriceLine(line);
      this.priceLines.delete(id);
    }
    const primitive = this.primitives.get(id);
    if (primitive) {
      this.series.detachPrimitive(primitive);
      this.primitives.delete(id);
    }
  }

  // ---- pointer handling ----

  private toAnchor(clientX: number, clientY: number): AnchorPoint | null {
    const rect = this.container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const time = this.chart.timeScale().coordinateToTime(x);
    const price = this.series.coordinateToPrice(y);
    if (time === null || price === null) return null;
    return { time, price };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;

    if (this.tool === 'horizontal') {
      const anchor = this.toAnchor(event.clientX, event.clientY);
      if (!anchor) return;
      this.commitNew({ id: newDrawingId(), kind: 'horizontal', price: anchor.price });
      return;
    }

    if (this.tool === 'trendline' || this.tool === 'fib') {
      const anchor = this.toAnchor(event.clientX, event.clientY);
      if (!anchor) return;

      if (!this.pendingStart) {
        this.pendingStart = anchor;
        this.previewPrimitive =
          this.tool === 'trendline'
            ? new TrendLinePrimitive(anchor, anchor, this.color, false)
            : new FibRetracementPrimitive(anchor, anchor, this.color, false);
        this.series.attachPrimitive(this.previewPrimitive);
        return;
      }

      const start = this.pendingStart;
      const tool = this.tool;
      this.cancelPending();
      this.commitNew(
        tool === 'trendline'
          ? { id: newDrawingId(), kind: 'trendline', start, end: anchor }
          : { id: newDrawingId(), kind: 'fib', start, end: anchor },
      );
      return;
    }

    // cursor: drag an existing drawing if the pointer landed on one, else select/deselect it.
    const hit = this.hitTest(event.clientX, event.clientY);
    if (hit) {
      this.drag = hit;
      this.chart.applyOptions({ handleScroll: false, handleScale: false });
      this.setSelected(hit.id);
      this.callbacks.onSelect(hit.id);
      return;
    }
    if (this.selectedId !== null) {
      this.setSelected(null);
      this.callbacks.onSelect(null);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.previewPrimitive) {
      const anchor = this.toAnchor(event.clientX, event.clientY);
      if (!anchor) return;
      this.previewPrimitive.end = anchor;
      this.previewPrimitive.refresh();
      return;
    }

    const drag = this.drag;
    if (!drag) return;
    const anchor = this.toAnchor(event.clientX, event.clientY);
    if (!anchor) return;

    if (drag.kind === 'horizontal') {
      this.priceLines.get(drag.id)?.applyOptions({ price: anchor.price });
      this.drawings = this.drawings.map((d) => (d.id === drag.id && d.kind === 'horizontal' ? { ...d, price: anchor.price } : d));
      return;
    }

    const primitive = this.primitives.get(drag.id);
    if (!primitive) return;
    if (drag.anchor === 'start') primitive.start = anchor;
    else primitive.end = anchor;
    primitive.refresh();
    this.drawings = this.drawings.map((d) => {
      if (d.id !== drag.id || d.kind === 'horizontal') return d;
      return drag.anchor === 'start' ? { ...d, start: anchor } : { ...d, end: anchor };
    });
  };

  private readonly onPointerUp = (): void => {
    if (!this.drag) return;
    this.drag = null;
    this.chart.applyOptions({ handleScroll: true, handleScale: true });
    this.callbacks.onDrawingsChange(this.drawings);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.pendingStart) return;
    this.cancelPending();
    this.callbacks.onPlaced();
  };

  private cancelPending(): void {
    if (this.previewPrimitive) {
      this.series.detachPrimitive(this.previewPrimitive);
      this.previewPrimitive = null;
    }
    this.pendingStart = null;
  }

  private commitNew(drawing: Drawing): void {
    this.drawings = [...this.drawings, drawing];
    this.upsert(drawing);
    this.callbacks.onDrawingsChange(this.drawings);
    this.callbacks.onPlaced();
  }

  private hitTest(clientX: number, clientY: number): DragState | null {
    const rect = this.container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    for (const drawing of this.drawings) {
      if (drawing.kind === 'horizontal') {
        const lineY = this.series.priceToCoordinate(drawing.price);
        if (lineY !== null && Math.abs(lineY - y) <= HIT_TOLERANCE_PX) {
          return { kind: 'horizontal', id: drawing.id };
        }
        continue;
      }
      const startPx = toPixel(this.chart, this.series, drawing.start);
      const endPx = toPixel(this.chart, this.series, drawing.end);
      if (startPx && withinTolerance(startPx, x, y)) return { kind: 'point', id: drawing.id, anchor: 'start' };
      if (endPx && withinTolerance(endPx, x, y)) return { kind: 'point', id: drawing.id, anchor: 'end' };
    }
    return null;
  }
}

function withinTolerance(point: PixelPoint, x: number, y: number): boolean {
  return Math.hypot(point.x - x, point.y - y) <= HIT_TOLERANCE_PX;
}
