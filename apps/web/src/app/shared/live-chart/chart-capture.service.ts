import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';

import {
  applyCandles,
  createCandleChart,
  disposeCandleChart,
  readPalette,
  type ChartPalette,
  type LiveCandle,
} from './chart-render';

/** Identity printed on the image — the model reads the ticker off the chart. */
export interface CaptureMeta {
  symbol: string;
  name: string;
  exchange: string;
  /** e.g. "1D · 90d", the same label the on-screen chart captions itself with. */
  timeframeLabel: string | null;
}

/**
 * Renders candles with the same chart library the user is looking at and
 * returns the result as a PNG, so the image the AI reads is the chart this
 * browser drew rather than a separate server-side picture of the same data.
 *
 * The chart is built off-screen at a fixed size instead of screenshotting the
 * visible one: the on-screen chart is only ~420px tall and as wide as the
 * layout happens to be, and it does not exist at all on the watchlist. A
 * fixed 1200x640 render gives every analysis the same legible geometry
 * regardless of where it was triggered from or what device it was triggered
 * on — and it still uses createCandleChart/applyCandles, so it stays visually
 * identical to the on-screen chart.
 */

const CHART_WIDTH = 1200;
const CHART_HEIGHT = 640;
/** Room above the chart for the symbol/exchange/timeframe caption. */
const HEADER_HEIGHT = 56;

@Injectable({ providedIn: 'root' })
export class ChartCaptureService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * Returns null rather than throwing when the chart cannot be produced (SSR,
   * no candles, a browser that refuses the canvas export). Callers treat that
   * as "send no image" and the API falls back to its own renderer, so a
   * capture failure costs image fidelity, never the analysis itself.
   *
   * The export asks for the overlay layer (`getConvertPictureUrl(true)`) even
   * though this chart carries none: drawing the analysis levels — or the
   * user's own trend lines — into the image the model reads is now a few
   * lines away, where the old library could only ever export bare candles.
   */
  async capture(candles: LiveCandle[], meta: CaptureMeta): Promise<Blob | null> {
    if (!this.isBrowser || candles.length === 0) return null;

    const container = document.createElement('div');
    // Off-screen rather than `display: none`: the library measures its
    // container, and a hidden element measures zero.
    container.style.cssText = `position:fixed;left:-10000px;top:0;width:${CHART_WIDTH}px;height:${CHART_HEIGHT}px;`;
    document.body.appendChild(container);

    // Tokens come from the document, not the detached container, so the
    // capture follows the theme the user is actually in.
    const palette = readPalette(document.body);

    try {
      const target = await createCandleChart(container, palette, candles);
      try {
        applyCandles(target, candles);
        // The library paints on an animation frame; two frames is one to
        // schedule the paint and one to be sure it landed before we read the
        // canvas back.
        await nextFrame();
        await nextFrame();
        const chartImage = await loadImage(
          target.chart.getConvertPictureUrl(true, 'png', palette.canvas),
        );
        return await this.compose(chartImage, meta, palette);
      } finally {
        disposeCandleChart(target);
      }
    } catch (cause) {
      console.warn('chart capture failed; falling back to the server-rendered chart', cause);
      return null;
    } finally {
      container.remove();
    }
  }

  /**
   * Stacks the caption above the chart screenshot. Without it the image
   * carries no ticker, and the prompt asks the model to read the symbol as
   * printed rather than infer it — an untitled chart comes back with a null
   * symbol.
   */
  private async compose(
    screenshot: HTMLImageElement,
    meta: CaptureMeta,
    palette: ChartPalette,
  ): Promise<Blob | null> {
    // The export renders at the device pixel ratio, so the caption is scaled
    // to match rather than assuming CSS pixels.
    const scale = screenshot.naturalWidth / CHART_WIDTH || 1;
    const header = Math.round(HEADER_HEIGHT * scale);

    const canvas = document.createElement('canvas');
    canvas.width = screenshot.naturalWidth;
    canvas.height = screenshot.naturalHeight + header;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = palette.canvas;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const pad = Math.round(16 * scale);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.textStrong;
    ctx.font = `600 ${Math.round(22 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`${meta.symbol} · ${meta.name} · ${meta.exchange}`, pad, header / 2);

    if (meta.timeframeLabel) {
      ctx.fillStyle = palette.text;
      ctx.font = `${Math.round(16 * scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(meta.timeframeLabel, canvas.width - pad, header / 2);
    }

    ctx.drawImage(screenshot, 0, header);

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  }
}

/**
 * Longest a paint is waited for before the canvas is read anyway.
 *
 * requestAnimationFrame does not fire at all in a backgrounded tab, so a user
 * who pressed Analyze and then switched away left this awaiting a frame that
 * would never come: the capture never settled, the button sat on "Drawing
 * chart…" forever, and the analysis request was never even sent. A timeout
 * turns that into, at worst, a slightly under-painted image — and the caller
 * treats a bad capture as "send no image", which the API already handles by
 * rendering its own chart.
 */
const FRAME_TIMEOUT_MS = 1_000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, FRAME_TIMEOUT_MS);
    requestAnimationFrame(done);
  });
}

/**
 * KLineChart hands back a data URL rather than the canvas it drew on, so the
 * picture has to be decoded before the caption can be stacked above it. A
 * data URL is same-origin and already in memory, so this only ever waits on
 * the decode.
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('chart export could not be decoded'));
    image.src = dataUrl;
  });
}
