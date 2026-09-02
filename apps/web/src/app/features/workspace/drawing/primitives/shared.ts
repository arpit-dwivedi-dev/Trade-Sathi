import type { IChartApiBase, IPrimitivePaneRenderer, ISeriesApi, SeriesType, Time } from 'lightweight-charts';

import type { AnchorPoint } from '../drawing.types';

/**
 * `CanvasRenderingTarget2D` (from the `fancy-canvas` package) is the real
 * parameter type of `IPrimitivePaneRenderer.draw`, but `fancy-canvas` is only
 * a transitive dependency (of `lightweight-charts`), not one of this app's —
 * importing it by name would rely on pnpm's hoisting rather than a declared
 * dependency. Deriving the type from the interface we already import avoids
 * that without losing any type safety.
 */
export type CanvasTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface PixelPoint {
  x: number;
  y: number;
}

/** Converts a time/price anchor to pixels, or null while off-screen / before the chart has laid out. */
export function toPixel(
  chart: IChartApiBase<Time> | null,
  series: ISeriesApi<SeriesType, Time> | null,
  point: AnchorPoint,
): PixelPoint | null {
  if (!chart || !series) return null;
  const x = chart.timeScale().timeToCoordinate(point.time);
  const y = series.priceToCoordinate(point.price);
  if (x === null || y === null) return null;
  return { x, y };
}

export const HANDLE_RADIUS = 5;

export function drawHandle(context: CanvasRenderingContext2D, point: PixelPoint, color: string): void {
  context.beginPath();
  context.fillStyle = color;
  context.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
  context.fill();
}
