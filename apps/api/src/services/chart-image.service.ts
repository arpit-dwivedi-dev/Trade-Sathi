import sharp from "sharp";
import type { Candle } from "../lib/market-data/types.js";

export interface ChartMeta {
  symbol: string;
  name: string;
  exchange: string;
  timeframeLabel: string; // e.g. "1D"
}

const WIDTH = 1200;
const HEIGHT = 700;
const MARGIN = { top: 60, right: 70, bottom: 40, left: 10 };
const VOLUME_HEIGHT = 100;
const PRICE_AREA_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom - VOLUME_HEIGHT - 10;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(value: number): string {
  return value >= 1000 ? value.toFixed(0) : value.toFixed(2);
}

// Every instrument this app charts trades on NSE/BSE (see the exchange->Yahoo
// suffix map in watchlist.service.ts), so intraday times are only meaningful
// to a reader — and to the model — in IST. The provider hands back UTC.
const IST_OFFSET_MINUTES = 5.5 * 60;

function formatDateLabel(iso: string): string {
  // Daily candles are date-only, so the calendar date is the whole label.
  if (iso.length <= 10) return iso.slice(0, 10);

  // Intraday candles all share a date or two, where the time of day is the
  // only part that distinguishes one label from the next.
  const ist = new Date(Date.parse(iso) + IST_OFFSET_MINUTES * 60 * 1000);
  const hours = String(ist.getUTCHours()).padStart(2, "0");
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Renders real OHLCV candles as a candlestick chart image, made to resemble
 * a normal chart screenshot so it can enter the exact same Visual AI pipeline
 * a pasted/uploaded screenshot does. Pure function: no I/O, no provider or
 * persistence knowledge — takes candles in, returns PNG bytes out.
 *
 * SVG is hand-built rather than pulling in a charting library: this repo has
 * no server-side charting dependency at all yet, and a plain string-built SVG
 * rasterized via `sharp` avoids introducing native canvas bindings for what
 * is a fairly small, fixed visual vocabulary (candles + axes + volume bars).
 */
export async function renderCandlestickChart(
  candles: Candle[],
  meta: ChartMeta,
): Promise<Buffer> {
  if (candles.length === 0) {
    throw new Error("renderCandlestickChart requires at least one candle");
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const priceRange = maxPrice - minPrice || 1;
  const maxVolume = Math.max(...candles.map((c) => c.volume), 1);

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const candleSlot = plotWidth / candles.length;
  const candleWidth = Math.max(2, candleSlot * 0.6);

  const priceBottom = MARGIN.top + PRICE_AREA_HEIGHT;
  const volumeTop = priceBottom + 10;
  const volumeBottom = volumeTop + VOLUME_HEIGHT;

  function xFor(index: number): number {
    return MARGIN.left + index * candleSlot + candleSlot / 2;
  }

  function yForPrice(price: number): number {
    return priceBottom - ((price - minPrice) / priceRange) * PRICE_AREA_HEIGHT;
  }

  const candleElements = candles
    .map((candle, index) => {
      const x = xFor(index);
      const isUp = candle.close >= candle.open;
      const color = isUp ? "#26a69a" : "#ef5350";
      const yHigh = yForPrice(candle.high);
      const yLow = yForPrice(candle.low);
      const yOpen = yForPrice(candle.open);
      const yClose = yForPrice(candle.close);
      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));

      return [
        `<line x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke="${color}" stroke-width="1.5" />`,
        `<rect x="${x - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${color}" />`,
      ].join("");
    })
    .join("");

  const volumeElements = candles
    .map((candle, index) => {
      const x = xFor(index);
      const isUp = candle.close >= candle.open;
      const color = isUp ? "#26a69a" : "#ef5350";
      const barHeight = (candle.volume / maxVolume) * VOLUME_HEIGHT;
      const y = volumeBottom - barHeight;
      return `<rect x="${x - candleWidth / 2}" y="${y}" width="${candleWidth}" height="${barHeight}" fill="${color}" opacity="0.5" />`;
    })
    .join("");

  const PRICE_TICKS = 5;
  const priceAxisElements = Array.from({ length: PRICE_TICKS + 1 }, (_, i) => {
    const price = minPrice + (priceRange * i) / PRICE_TICKS;
    const y = yForPrice(price);
    return [
      `<line x1="${MARGIN.left}" y1="${y}" x2="${WIDTH - MARGIN.right}" y2="${y}" stroke="#2a2e39" stroke-width="1" />`,
      `<text x="${WIDTH - MARGIN.right + 8}" y="${y + 4}" font-size="13" fill="#787b86" font-family="monospace">${formatPrice(price)}</text>`,
    ].join("");
  }).join("");

  const TIME_TICKS = Math.min(6, candles.length);
  const timeAxisElements = Array.from({ length: TIME_TICKS }, (_, i) => {
    const index = Math.floor((candles.length - 1) * (i / Math.max(1, TIME_TICKS - 1)));
    const candle = candles[index];
    const x = xFor(index);
    return `<text x="${x}" y="${volumeBottom + 20}" font-size="12" fill="#787b86" font-family="monospace" text-anchor="middle">${formatDateLabel(candle.timestamp)}</text>`;
  }).join("");

  const title = `${escapeXml(meta.symbol)} · ${escapeXml(meta.name)} · ${escapeXml(meta.exchange)}`;

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#131722" />
    <text x="${MARGIN.left}" y="30" font-size="22" fill="#d1d4dc" font-family="sans-serif" font-weight="bold">${title}</text>
    <text x="${WIDTH - MARGIN.right}" y="30" font-size="16" fill="#787b86" font-family="sans-serif" text-anchor="end">${escapeXml(meta.timeframeLabel)}</text>
    ${priceAxisElements}
    ${candleElements}
    ${timeAxisElements}
    <text x="${MARGIN.left}" y="${volumeTop - 4}" font-size="12" fill="#787b86" font-family="sans-serif">Volume</text>
    ${volumeElements}
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
