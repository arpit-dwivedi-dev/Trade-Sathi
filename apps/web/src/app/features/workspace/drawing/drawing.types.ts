import type { Time } from 'lightweight-charts';

/** The manual analysis workspace's drawing tools — 'cursor' selects/drags, the rest place a new drawing. */
export type DrawTool = 'cursor' | 'trendline' | 'horizontal' | 'fib';

export interface AnchorPoint {
  time: Time;
  price: number;
}

export interface HorizontalLineDrawing {
  id: string;
  kind: 'horizontal';
  price: number;
}

export interface TrendLineDrawing {
  id: string;
  kind: 'trendline';
  start: AnchorPoint;
  end: AnchorPoint;
}

export interface FibDrawing {
  id: string;
  kind: 'fib';
  start: AnchorPoint;
  end: AnchorPoint;
}

export type Drawing = HorizontalLineDrawing | TrendLineDrawing | FibDrawing;

/** The standard Fibonacci retracement ratios — no extensions (1.272/1.618). */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export function newDrawingId(): string {
  return `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
