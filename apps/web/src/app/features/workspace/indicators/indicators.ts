import type { Time } from 'lightweight-charts';

import { toTime } from '../../../shared/live-chart/chart-render';
import type { LiveCandle } from '../../../shared/live-chart/live-chart';

/**
 * Standard technical indicators, computed client-side from the same candles
 * the chart already has — no server round trip, no new dependency. Every
 * function is pure: same candles in, same series out.
 */

export interface IndicatorPoint {
  time: Time;
  value: number;
}

export interface BollingerPoint {
  time: Time;
  basis: number;
  upper: number;
  lower: number;
}

export interface MacdPoint {
  time: Time;
  macd: number;
  signal: number;
  histogram: number;
}

/** Simple moving average of `values`, aligned 1:1 with the input — null before `period` points exist. */
function smaValues(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * non-null values (the standard convention). Accepts a nullable input series
 * so it can also smooth a derived series that itself starts partway through
 * (e.g. the MACD line, which needs both a fast and slow EMA to exist first).
 */
function emaValues(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  const k = 2 / (period + 1);
  let seedSum = 0;
  let seedCount = 0;
  let prev: number | null = null;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) {
      if (v === null) continue;
      seedSum += v;
      seedCount++;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
      continue;
    }
    if (v === null) continue;
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function zip(candles: LiveCandle[], values: (number | null)[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  for (let i = 0; i < candles.length; i++) {
    const value = values[i];
    if (value !== null) out.push({ time: toTime(candles[i].timestamp), value });
  }
  return out;
}

export function sma(candles: LiveCandle[], period = 20): IndicatorPoint[] {
  return zip(candles, smaValues(candles.map((c) => c.close), period));
}

export function ema(candles: LiveCandle[], period = 21): IndicatorPoint[] {
  return zip(candles, emaValues(candles.map((c) => c.close), period));
}

export function bollingerBands(candles: LiveCandle[], period = 20, multiplier = 2): BollingerPoint[] {
  const closes = candles.map((c) => c.close);
  const basisValues = smaValues(closes, period);
  const out: BollingerPoint[] = [];

  for (let i = 0; i < candles.length; i++) {
    const basis = basisValues[i];
    if (basis === null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - basis) ** 2;
    const stdDev = Math.sqrt(variance / period);
    out.push({
      time: toTime(candles[i].timestamp),
      basis,
      upper: basis + multiplier * stdDev,
      lower: basis - multiplier * stdDev,
    });
  }
  return out;
}

/** Wilder's RSI — the standard smoothing method, not a plain moving average of gains/losses. */
export function rsi(candles: LiveCandle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out.push({ time: toTime(candles[period].timestamp), value: rsiFromAverages(avgGain, avgLoss) });

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push({ time: toTime(candles[i].timestamp), value: rsiFromAverages(avgGain, avgLoss) });
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(candles: LiveCandle[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MacdPoint[] {
  const closes = candles.map((c) => c.close);
  const fastEma = emaValues(closes, fastPeriod);
  const slowEma = emaValues(closes, slowPeriod);
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const f = fastEma[i];
    const s = slowEma[i];
    return f !== null && s !== null ? f - s : null;
  });
  const signalLine = emaValues(macdLine, signalPeriod);

  const out: MacdPoint[] = [];
  for (let i = 0; i < candles.length; i++) {
    const m = macdLine[i];
    const s = signalLine[i];
    if (m === null || s === null) continue;
    out.push({ time: toTime(candles[i].timestamp), macd: m, signal: s, histogram: m - s });
  }
  return out;
}
