import type {
  Chart,
  DeepPartial,
  IndicatorStyle,
  KLineData,
  OverlayFigure,
  Period,
  Styles,
  YAxisOverride,
} from 'klinecharts';

/**
 * The two chart styles the app exposes to the user. KLineChart itself has
 * more (`ohlc`, stroke variants, …); these are the two names traders
 * actually ask for, mapped onto the library's `candle.type` below.
 */
export type ChartStyle = 'candle' | 'line';

function candleTypeFor(style: ChartStyle): 'candle_solid' | 'area' {
  return style === 'line' ? 'area' : 'candle_solid';
}

import { FONT_UI } from '../typography';

/**
 * The chart vocabulary shared by every place this app draws candles with
 * KLineChart: the on-screen chart component, the manual-analysis workspace
 * chart, and the off-screen renderer that produces the image the AI reads.
 *
 * It lives apart from the components because those must stay visually
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
/**
 * One price band drawn on the chart — both edges as lines, sharing a label.
 *
 * A band, not a price, because that is what the analysis actually produces: a
 * level zone spans the reactions it is grounded in, and a trigger is the zone
 * a close has to clear. Collapsing either to its midpoint to get one tidy line
 * would draw a precision the read does not claim.
 */
export interface OverlayBand {
  low: number;
  high: number;
  label: string;
}

export interface ChartOverlays {
  /** Support zones, drawn in the up colour. */
  support: OverlayBand[];
  /** Resistance zones, drawn in the down colour. */
  resistance: OverlayBand[];
  /** Trigger zones — where a scenario becomes live. Dashed. */
  trigger: OverlayBand[];
  /** Single prices, because these genuinely are single prices. */
  targets: number[];
  invalidations: number[];
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
  /** The chart's own background — the deep canvas, not the panel around it. */
  canvas: string;
  accent: string;
}

/** Used when a token is missing — during SSR, or before styles are applied.
 *
 * These are the dark palette's literals (tokens.css), not the light one's: a
 * chart that renders before the theme resolves should flash the canvas colour
 * it will settle on, and dark is what this surface is designed around. */
const FALLBACK_PALETTE: ChartPalette = {
  up: '#089981',
  down: '#f23645',
  flat: '#787b86',
  text: '#787b86',
  textStrong: '#d1d4dc',
  line: '#2b3139',
  lineSoft: '#21252f',
  canvas: '#131722',
  accent: '#2962ff',
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
    canvas: token('--bg-canvas', FALLBACK_PALETTE.canvas),
    accent: token('--acc', FALLBACK_PALETTE.accent),
  };
}

/**
 * KLineChart reads `window` at module scope (it resolves the hotkey modifier
 * alias from the platform), so a static import crashes the SSR render before
 * any of this app's own browser guards get a chance to run. Every entry point
 * below therefore reaches the library through this loader, and the components
 * only call in once they know they are in a browser.
 *
 * The promise is memoised rather than the module: two charts constructed in
 * the same tick must not both trigger a download, and the one-time overlay
 * registration below must not run twice.
 */
export type KLineChartsModule = typeof import('klinecharts');

let modulePromise: Promise<KLineChartsModule> | null = null;

export function loadKLineCharts(): Promise<KLineChartsModule> {
  modulePromise ??= import('klinecharts').then((kc) => {
    registerLevelOverlay(kc);
    return kc;
  });
  return modulePromise;
}

/** Ticker handed to setSymbol. Nothing displays it — the caption is drawn by the caller. */
const TICKER = 'chart';
const CANDLE_PANE_ID = 'candle_pane';
const VOLUME_INDICATOR_ID = 'chart_volume';
/** The y-axis the volume bars get, so their scale never distorts the price scale. */
const VOLUME_AXIS_ID = 'volume_axis';
/** Volume occupies the bottom fifth of the candle pane, as it did before the migration. */
const VOLUME_PANE_SHARE = 0.2;

/**
 * The volume scale, hidden and squashed into the bottom of the candle pane.
 *
 * `createRange` rather than `gap` because the two mean different things:
 * KLineChart's gap is headroom expressed as a fraction of the *data* range,
 * and any value that reaches 1 is re-read as a pixel count — so it cannot say
 * "leave the top four fifths empty" at all. Stretching the range itself can:
 * an axis five times the tallest bar leaves the bars in the bottom fifth.
 */
const VOLUME_AXIS: YAxisOverride = {
  paneId: CANDLE_PANE_ID,
  id: VOLUME_AXIS_ID,
  needWidget: false,
  gap: { top: 0, bottom: 0 },
  createRange: ({ defaultRange }) => {
    const realTo = defaultRange.realTo / VOLUME_PANE_SHARE;
    // A window with no volume at all has nothing to scale.
    if (!(realTo > 0)) return defaultRange;
    return {
      ...defaultRange,
      from: 0,
      to: realTo,
      range: realTo,
      realFrom: 0,
      realTo,
      realRange: realTo,
      displayFrom: 0,
      displayTo: realTo,
      displayRange: realTo,
    };
  },
};

/**
 * Distinct, theme-independent colours for indicator line figures, in the order
 * the library asks for them.
 *
 * The brand blue leads, then five hues chosen to stay apart from each other at
 * a 1px stroke. None of them is the market teal or the market coral: an
 * indicator line the same colour as a candle body would be read as price.
 */
const INDICATOR_LINE_COLORS = ['#2962ff', '#ff9800', '#9d2bff', '#00bcd4', '#e91e63', '#7cb342'];

/** Volume bars are the candle colours at low alpha, as they were before the migration. */
function volumeStyles(palette: ChartPalette): DeepPartial<IndicatorStyle> {
  return {
    bars: [
      {
        upColor: `${palette.up}55`,
        downColor: `${palette.down}55`,
        noChangeColor: `${palette.flat}55`,
      },
    ],
  };
}

/**
 * The custom overlay behind the analysis levels (support, resistance, entry,
 * target, stop). The built-in `priceLine` draws the price but no title, and
 * KLineChart only shows an overlay's y-axis tag while it is hovered — this
 * app's levels have to stay labelled and readable in a static PNG, so they
 * carry their own title text.
 */
const LEVEL_OVERLAY = 'analysisLevel';

interface LevelExtend {
  title: string;
}

function registerLevelOverlay(kc: KLineChartsModule): void {
  kc.registerOverlay<LevelExtend>({
    name: LEVEL_OVERLAY,
    // Programmatic only: one point, supplied at creation, never drawn or
    // dragged by hand.
    totalStep: 1,
    lock: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ overlay, coordinates, bounding }): OverlayFigure[] => {
      const y = coordinates[0]?.y;
      if (y === undefined) return [];
      return [
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        },
        {
          type: 'text',
          ignoreEvent: true,
          attrs: {
            x: bounding.width - 4,
            y,
            text: overlay.extendData.title,
            align: 'right',
            baseline: 'middle',
          },
        },
      ];
    },
  });
}

/**
 * Everything about a chart's look that a theme change can move. Kept separate
 * from construction so a running chart can reapply it without being rebuilt
 * (and so without resetting the user's pan/zoom).
 *
 * The font family is set on every text style the library exposes, because the
 * chart is a <canvas>: no stylesheet reaches it, and KLineChart's own default
 * is Helvetica Neue — a face neither Linux nor Windows has, so axis labels
 * were resolving to a different fallback than the DOM sitting beside them.
 */
export function chartStyles(palette: ChartPalette, style: ChartStyle = 'candle'): DeepPartial<Styles> {
  const axis = {
    axisLine: { color: palette.line },
    tickLine: { color: palette.line },
    tickText: { color: palette.text, family: FONT_UI },
  };

  // A tooltip's family sits on its two text styles rather than on the tooltip,
  // and candle and indicator tooltips are separate types with the same shape.
  const tooltipText = {
    title: { family: FONT_UI },
    legend: { family: FONT_UI },
  };

  return {
    grid: {
      horizontal: { color: palette.line },
      vertical: { color: palette.line },
    },
    candle: {
      type: candleTypeFor(style),
      bar: {
        upColor: palette.up,
        downColor: palette.down,
        noChangeColor: palette.flat,
        upBorderColor: palette.up,
        downBorderColor: palette.down,
        noChangeBorderColor: palette.flat,
        upWickColor: palette.up,
        downWickColor: palette.down,
        noChangeWickColor: palette.flat,
      },
      // Only read in 'area' mode — a single line+fill in the accent colour,
      // rather than the up/down colouring candles use, since a line chart has
      // no per-bar direction to colour by.
      area: {
        lineColor: palette.accent,
        lineSize: 1.5,
        value: 'close',
        backgroundColor: [
          { offset: 0, color: `${palette.accent}33` },
          { offset: 1, color: `${palette.accent}00` },
        ],
      },
      priceMark: {
        last: {
          upColor: palette.up,
          downColor: palette.down,
          noChangeColor: palette.flat,
          text: { family: FONT_UI },
        },
      },
      tooltip: { showRule: 'follow_cross', ...tooltipText },
    },
    indicator: {
      // One palette for every indicator the workspace can switch on, rather
      // than a colour per indicator: KLineChart draws a figure per parameter
      // (MA's four periods, BOLL's three bands), so colours belong to the
      // figure slot, not to the study.
      lines: INDICATOR_LINE_COLORS.map((color) => ({ color })),
      // Histogram indicators — MACD above all — read as up/down against the
      // candles they are being compared with.
      bars: [{ upColor: palette.up, downColor: palette.down, noChangeColor: palette.flat }],
      tooltip: { showRule: 'follow_cross', ...tooltipText },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { color: palette.line },
    crosshair: {
      horizontal: {
        line: { color: palette.text },
        text: { backgroundColor: palette.text, family: FONT_UI },
      },
      vertical: {
        line: { color: palette.text },
        text: { backgroundColor: palette.text, family: FONT_UI },
      },
    },
    overlay: {
      point: { color: palette.accent, borderColor: `${palette.accent}44`, activeColor: palette.accent },
      line: { color: palette.accent },
      text: { color: palette.textStrong, family: FONT_UI },
    },
  };
}

/**
 * KLineChart v10 has no imperative "set this data" call: the chart pulls from
 * a DataLoader and pushes single-bar updates through the subscription that
 * loader hands back. This holds both ends of that contract, so the app keeps
 * the imperative applyCandles/updateLastCandle shape it already had.
 */
interface CandleFeed {
  bars: KLineData[];
  /** Set by the chart when it subscribes; the incremental single-bar path. */
  push: ((bar: KLineData) => void) | null;
  period: Period;
  pricePrecision: number;
}

export interface CandleChart {
  chart: Chart;
  feed: CandleFeed;
  /** The style last applied, so a palette repaint doesn't drop back to candles. */
  style: ChartStyle;
}

/**
 * Builds a price + volume chart inside `element`. Volume shares the candle
 * pane but gets its own hidden y-axis pinned to the bottom fifth, so the
 * on-screen chart and the off-screen capture produce the same layout.
 */
export async function createCandleChart(
  element: HTMLElement,
  palette: ChartPalette,
  candles: LiveCandle[],
  style: ChartStyle = 'candle',
): Promise<CandleChart> {
  const kc = await loadKLineCharts();

  const chart = kc.init(element, {
    styles: chartStyles(palette, style),
    locale: 'en-US',
  });
  if (!chart) throw new Error('KLineChart refused to initialise on this element');

  const feed: CandleFeed = {
    bars: candles.map(toBar),
    push: null,
    period: inferPeriod(candles),
    pricePrecision: inferPricePrecision(candles),
  };

  // Symbol and period must be set before the loader: resetData only fetches
  // once all three are present, and setDataLoader is what triggers it.
  chart.setSymbol({ ticker: TICKER, pricePrecision: feed.pricePrecision, volumePrecision: 0 });
  chart.setPeriod(feed.period);
  chart.setDataLoader({
    getBars: ({ type, callback }) => {
      // Only 'init' can ever produce data here: this app fetches whole
      // windows up front, so there is nothing to page in at either edge.
      // Answering forward/backward with an empty, no-more result is what
      // stops the chart asking again on every scroll to the edge.
      callback(type === 'init' ? feed.bars : [], false);
    },
    subscribeBar: ({ callback }) => {
      feed.push = callback;
    },
    unsubscribeBar: () => {
      feed.push = null;
    },
  });

  // calcParams: [] drops VOL's default moving-average lines — this is the
  // volume histogram the app has always drawn, not a volume study.
  chart.createIndicator(
    {
      id: VOLUME_INDICATOR_ID,
      name: 'VOL',
      paneId: CANDLE_PANE_ID,
      yAxisId: VOLUME_AXIS_ID,
      calcParams: [],
      styles: volumeStyles(palette),
    },
    true,
  );
  chart.overrideYAxis(VOLUME_AXIS);

  return { chart, feed, style };
}

/**
 * Repaints a running chart in `palette` without touching its data, so a theme
 * toggle never costs the user their pan or zoom. Volume is set separately from
 * the global styles because its bars are indicator-scoped, and a global bar
 * colour would drag MACD's histogram along with it.
 */
export function applyPalette(target: CandleChart, palette: ChartPalette): void {
  target.chart.setStyles(chartStyles(palette, target.style));
  target.chart.overrideIndicator({
    id: VOLUME_INDICATOR_ID,
    name: 'VOL',
    styles: volumeStyles(palette),
  });
}

/** Switches between candle and line rendering without touching data, pan, or zoom. */
export function applyChartStyle(target: CandleChart, palette: ChartPalette, style: ChartStyle): void {
  target.style = style;
  target.chart.setStyles(chartStyles(palette, style));
}

export function disposeCandleChart(target: CandleChart): void {
  void loadKLineCharts().then((kc) => kc.dispose(target.chart));
}

/**
 * Replaces the whole series. This is the expensive path — the chart reloads
 * from the feed and refits — so it belongs to a window change, not to a price
 * moving. See updateLastCandle for the latter.
 */
export function applyCandles(target: CandleChart, candles: LiveCandle[]): void {
  const { chart, feed } = target;
  feed.bars = candles.map(toBar);

  const period = inferPeriod(candles);
  const pricePrecision = inferPricePrecision(candles);

  // setSymbol and setPeriod each reload the feed themselves; resetData is the
  // reload for the (common) case where neither of them moved.
  let reloaded = false;
  if (feed.pricePrecision !== pricePrecision) {
    feed.pricePrecision = pricePrecision;
    chart.setSymbol({ ticker: TICKER, pricePrecision, volumePrecision: 0 });
    reloaded = true;
  }
  if (feed.period.type !== period.type || feed.period.span !== period.span) {
    feed.period = period;
    chart.setPeriod(period);
    reloaded = true;
  }
  if (!reloaded) chart.resetData();

  // A reload rebuilds the candle pane's y-axes, so the volume axis has to be
  // re-pinned; without this it reverts to sharing the full price scale and
  // the bars swamp the candles.
  chart.overrideYAxis(VOLUME_AXIS);
}

/**
 * Redraws only the newest candle, which is the one a live price moves.
 *
 * This exists because streaming made the difference matter: reloading the
 * whole feed on every tick reparses the entire series and snaps the time
 * scale back — so a live chart both stuttered and fought any pan or zoom the
 * user tried. The subscription callback touches one bar, replacing it when
 * the timestamp matches the last one, which is what makes a streaming chart
 * feel immediate rather than merely correct.
 */
export function updateLastCandle(target: CandleChart, candle: LiveCandle): void {
  target.feed.push?.(toBar(candle));
}

/**
 * Draws the analysis levels, replacing whatever was there. Shared by the Live
 * tab chart and the workspace chart, which drew an identical set of lines from
 * two copies of this code before the migration.
 */
export function drawLevelOverlays(
  target: CandleChart,
  overlays: ChartOverlays | null,
  palette: ChartPalette,
): void {
  const { chart } = target;
  chart.removeOverlay({ name: LEVEL_OVERLAY });
  if (!overlays) return;

  const add = (value: number, title: string, color: string, dashed: boolean): void => {
    chart.createOverlay({
      name: LEVEL_OVERLAY,
      points: [{ value }],
      extendData: { title },
      lock: true,
      styles: {
        line: { color, size: 1, style: dashed ? 'dashed' : 'solid' },
        // A filled tag rather than the library's default blue one, so the
        // label reads as belonging to its line — and stays legible in the
        // PNG the model is sent.
        text: {
          color: palette.canvas,
          backgroundColor: color,
          borderColor: color,
          size: 10,
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 2,
          paddingBottom: 2,
        },
      },
    });
  };

  /**
   * A zone as its two edges. The label goes on the near edge only — tagging
   * both just prints the same word twice a few pixels apart, and on a tight
   * band the two tags overlap into something unreadable.
   */
  const addBand = (zone: OverlayBand, color: string, dashed: boolean): void => {
    add(zone.high, zone.label, color, dashed);
    if (zone.low !== zone.high) add(zone.low, '', color, dashed);
  };

  for (const zone of overlays.support) addBand(zone, palette.up, false);
  for (const zone of overlays.resistance) addBand(zone, palette.down, false);
  for (const zone of overlays.trigger) addBand(zone, palette.accent, true);
  for (const target of overlays.targets) add(target, 'Target', palette.up, true);
  for (const invalidation of overlays.invalidations) add(invalidation, 'Stop', palette.down, true);
}

/**
 * Daily candles are date-only and are read as local midnight, not UTC: the
 * chart formats its axis in the viewer's timezone, and a UTC midnight would
 * render as the previous day for anyone west of Greenwich. Intraday candles
 * carry a real instant and parse as one.
 */
export function toTimestamp(timestamp: string): number {
  if (timestamp.length <= 10) {
    const [year, month, day] = timestamp.split('-').map(Number);
    return new Date(year, month - 1, day).getTime();
  }
  return Date.parse(timestamp);
}

function toBar(candle: LiveCandle): KLineData {
  return {
    timestamp: toTimestamp(candle.timestamp),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

/**
 * KLineChart formats the x-axis from the period rather than from the data, so
 * it has to be told the granularity. Nothing upstream carries it in this
 * shape — the callers hold a display label ("1D · 90d") or an interval in
 * minutes — so it is read back off the candles.
 *
 * The *smallest* gap is the granularity: the largest and the average are both
 * distorted by weekends, holidays and session breaks.
 */
function inferPeriod(candles: LiveCandle[]): Period {
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < candles.length; i += 1) {
    const gap = toTimestamp(candles[i].timestamp) - toTimestamp(candles[i - 1].timestamp);
    if (gap > 0 && gap < smallest) smallest = gap;
  }
  if (!Number.isFinite(smallest)) return { type: 'day', span: 1 };

  const minutes = Math.round(smallest / 60_000);
  if (minutes >= 1440) return { type: 'day', span: Math.max(1, Math.round(minutes / 1440)) };
  if (minutes >= 60 && minutes % 60 === 0) return { type: 'hour', span: minutes / 60 };
  return { type: 'minute', span: Math.max(1, minutes) };
}

/**
 * How many decimals the price axis and crosshair show. Read off the data
 * because nothing upstream carries an instrument's tick size — an Indian
 * equity quotes to 2 places, an FX or crypto pair to more, and rounding
 * either one to a fixed guess is visible on the axis.
 */
function inferPricePrecision(candles: LiveCandle[]): number {
  let decimals = 0;
  for (const candle of candles.slice(-100)) {
    for (const price of [candle.open, candle.high, candle.low, candle.close]) {
      const text = String(price);
      const dot = text.indexOf('.');
      // Exponential notation carries no readable decimal count; the clamp
      // below covers those.
      if (dot >= 0 && !text.includes('e')) decimals = Math.max(decimals, text.length - dot - 1);
    }
  }
  return Math.min(Math.max(decimals, 2), 6);
}
