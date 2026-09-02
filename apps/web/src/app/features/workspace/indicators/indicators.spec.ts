import { describe, expect, it } from 'vitest';

import type { LiveCandle } from '../../../shared/live-chart/live-chart';
import { bollingerBands, ema, macd, rsi, sma } from './indicators';

function candles(closes: number[]): LiveCandle[] {
  return closes.map((close, i) => ({
    timestamp: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }));
}

describe('sma', () => {
  it('averages the trailing window and skips points before it fills', () => {
    const points = sma(candles([1, 2, 3, 4, 5]), 3);
    expect(points.map((p) => p.value)).toEqual([2, 3, 4]);
  });
});

describe('ema', () => {
  it('seeds with the SMA of the first period, then smooths forward', () => {
    const points = ema(candles([1, 2, 3, 4, 5]), 3);
    // Linear input: EMA of a straight line tracks the line exactly once seeded.
    expect(points.map((p) => p.value)).toEqual([2, 3, 4]);
  });
});

describe('bollingerBands', () => {
  it('computes basis and a symmetric band from the trailing standard deviation', () => {
    const points = bollingerBands(candles([1, 2, 3, 4, 5]), 3, 2);
    expect(points).toHaveLength(3);
    expect(points[0].basis).toBe(2);
    expect(points[0].upper).toBeCloseTo(3.633, 2);
    expect(points[0].lower).toBeCloseTo(0.367, 2);
    // Upper/lower stay equidistant from basis at every point.
    for (const p of points) {
      expect(p.upper - p.basis).toBeCloseTo(p.basis - p.lower, 6);
    }
  });
});

describe('rsi', () => {
  it("matches Wilder's smoothing by hand for a short known series", () => {
    const points = rsi(candles([10, 12, 11, 13, 9]), 3);
    expect(points).toHaveLength(2);
    expect(points[0].value).toBeCloseTo(80, 4);
    expect(points[1].value).toBeCloseTo(36.3636, 3);
  });

  it('reports 100 when every change in the window is a gain', () => {
    const points = rsi(candles([1, 2, 3, 4, 5]), 3);
    expect(points.every((p) => p.value === 100)).toBe(true);
  });
});

describe('macd', () => {
  it('produces a constant zero histogram for a straight-line series', () => {
    // Two EMAs of a linear series stay a constant distance apart once both
    // have seeded, so macd - signal (the histogram) settles at exactly 0.
    const points = macd(candles([1, 2, 3, 4, 5, 6, 7]), 2, 3, 2);
    expect(points).toHaveLength(4);
    for (const p of points) {
      expect(p.macd).toBeCloseTo(0.5, 6);
      expect(p.signal).toBeCloseTo(0.5, 6);
      expect(p.histogram).toBeCloseTo(0, 6);
    }
  });
});
