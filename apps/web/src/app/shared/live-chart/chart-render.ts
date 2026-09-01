import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

/**
 * The chart vocabulary shared by every place this app draws candles with
 * lightweight-charts: the on-screen chart component and the off-screen
 * renderer that produces the image the AI reads.
 *
 * It lives apart from the component because those two must stay visually
 * identical — the user is told the model reads the same chart they are looking
 * at, and that stops being true the moment one of them keeps its own copy of
 * the colours, scales or time mapping.
 */

/** One candle, in the shape /api/market/candles returns it. */
export interface LiveCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Price levels drawn on top of the candles, straight from an analysis row. */
export interface ChartOverlays {
  support: number[];
  resistance: number[];
  entry: number | null;
  target: number | null;
  invalidation: number | null;
}

/** Chart colours, read from the app's CSS tokens so a theme change carries. */
export interface ChartPalette {
  up: string;
  down: string;
  flat: string;
  text: string;
  /** Primary body text — the chart caption/title, not the axis labels. */
  textStrong: string;
  line: string;
  lineSoft: string;
  surface: string;
  accent: string;
}

/** Used when a token is missing — during SSR, or before styles are applied. */
const FALLBACK_PALETTE: ChartPalette = {
  up: '#047857',
  down: '#b91c1c',
  flat: '#6b7280',
  text: '#7a7286',
  textStrong: '#16121f',
  line: '#e6e3f1',
  lineSoft: '#f0eef8',
  surface: '#ffffff',
  accent: '#6c3ce0',
};

export function readPalette(element: HTMLElement): ChartPalette {
  const styles = getComputedStyle(element);
  const token = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback;

  return {
    up: token('--up', FALLBACK_PALETTE.up),
    down: token('--down', FALLBACK_PALETTE.down),
    flat: token('--flat', FALLBACK_PALETTE.flat),
    text: token('--tx-3', FALLBACK_PALETTE.text),
    textStrong: token('--tx', FALLBACK_PALETTE.textStrong),
    line: token('--line', FALLBACK_PALETTE.line),
    lineSoft: token('--line-soft', FALLBACK_PALETTE.lineSoft),
    surface: token('--surf', FALLBACK_PALETTE.surface),
    accent: token('--acc', FALLBACK_PALETTE.accent),
  };
}

/**
 * Everything about a chart's look that a theme change can move. Kept separate
 * from series construction so the on-screen chart can reapply it without
 * rebuilding (and so without resetting the user's pan/zoom).
 */
export function chartOptions(
  palette: ChartPalette,
  background = 'transparent',
): Parameters<IChartApi['applyOptions']>[0] {
  return {
    layout: {
      background: { color: background },
      textColor: palette.text,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: palette.lineSoft },
      horzLines: { color: palette.lineSoft },
    },
    rightPriceScale: { borderColor: palette.line },
    timeScale: {
      borderColor: palette.line,
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: { mode: 1 },
  };
}

export interface CandleChart {
  chart: IChartApi;
  priceSeries: ISeriesApi<'Candlestick'>;
  volumeSeries: ISeriesApi<'Histogram'>;
}

/**
 * Builds a price + volume chart inside `element`. Volume shares the pane but
 * gets its own hidden scale pinned to the bottom fifth, so both renderers
 * produce the same layout.
 */
export function createCandleChart(
  element: HTMLElement,
  palette: ChartPalette,
  size: { width: number; height: number },
  background = 'transparent',
): CandleChart {
  const chart = createChart(element, {
    ...chartOptions(palette, background),
    autoSize: false,
    width: size.width,
    height: size.height,
  });

  const priceSeries = chart.addSeries(CandlestickSeries, {
    upColor: palette.up,
    downColor: palette.down,
    borderUpColor: palette.up,
    borderDownColor: palette.down,
    wickUpColor: palette.up,
    wickDownColor: palette.down,
  });

  const volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    color: palette.flat,
  });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

  return { chart, priceSeries, volumeSeries };
}

/**
 * Daily candles are date-only and map to lightweight-charts' business-day
 * form; intraday candles carry a real instant and map to a UTC timestamp.
 * Mixing the two in one series is a library error, but a series only ever
 * holds one granularity's worth of data (a window change replaces it whole).
 */
export function toTime(timestamp: string): Time {
  if (timestamp.length <= 10) return timestamp;
  return (Date.parse(timestamp) / 1000) as UTCTimestamp;
}

export function applyCandles(
  target: CandleChart,
  candles: LiveCandle[],
  palette: ChartPalette,
): void {
  const bars: CandlestickData[] = [];
  const volumes: HistogramData[] = [];

  for (const candle of candles) {
    const time = toTime(candle.timestamp);
    bars.push({
      time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });
    volumes.push({
      time,
      value: candle.volume,
      color: candle.close >= candle.open ? `${palette.up}55` : `${palette.down}55`,
    });
  }

  target.priceSeries.setData(bars);
  target.volumeSeries.setData(volumes);
  target.chart.timeScale().fitContent();
}
