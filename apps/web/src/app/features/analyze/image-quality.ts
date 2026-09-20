/**
 * Client-side, pre-upload screening of a candidate chart screenshot.
 *
 * Every analysis costs a credit whether or not the image was readable, and the
 * most common wasted credit is an image a human could have rejected on sight:
 * a phone photo of a monitor, a thumbnail, a heavily re-compressed forward.
 * This runs entirely in the browser — no API call, no credit — so the user can
 * be warned before they spend anything.
 *
 * It only ever *warns*. Every check here is a heuristic over pixels, and a
 * false positive that blocked a perfectly good chart would cost more than the
 * occasional credit it saves, so the caller is expected to let the user
 * proceed anyway. For the same reason an inspection that throws reports no
 * issues rather than failing the upload.
 */

export type ImageQualityIssueCode = 'low_resolution' | 'blurry' | 'odd_shape';

export interface ImageQualityIssue {
  code: ImageQualityIssueCode;
  /** User-facing, already phrased as what's wrong with *their* screenshot. */
  message: string;
}

export interface ImageQualityReport {
  issues: ImageQualityIssue[];
  width: number;
  height: number;
  /**
   * Variance of the Laplacian over the normalized sample, i.e. how much
   * high-frequency detail survives. Exposed for tuning the thresholds against
   * real uploads; nothing in the UI reads it.
   */
  sharpness: number;
}

/**
 * The image is resampled to this longer edge before sharpness is measured.
 * A fixed size is what makes the number comparable: the same chart at 4K and
 * at 1280px otherwise scores very differently, because Laplacian variance
 * scales with how many pixels a given edge is spread across.
 */
const SAMPLE_EDGE_PX = 720;

/**
 * Below this the analysis is reading price labels that are a few pixels tall.
 * Both edges are checked because a wide-but-short crop fails for the same
 * reason a small square one does.
 */
const MIN_SHORT_EDGE_PX = 380;
const MIN_LONG_EDGE_PX = 640;

/**
 * Sharpness floor. A crisp screenshot of a candlestick chart sits far above
 * this — the candle bodies and gridlines are hard edges. A photo of a screen,
 * or an image that has been scaled down and back up by a messaging app, lands
 * below it. Deliberately conservative: it is better to miss a soft image than
 * to nag someone holding a good one.
 */
const MIN_SHARPNESS = 55;

/**
 * Beyond this the screenshot is a sliver — usually one pane of a trading
 * platform, or a full-height phone screenshot with the chart in a small band.
 */
const MAX_ASPECT_RATIO = 3.2;

/**
 * Mean of the squared Laplacian response minus the square of its mean, over a
 * grayscale sample. The border pixels are skipped rather than clamped so the
 * frame edge doesn't register as a hard edge of its own.
 */
function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const response =
        gray[i - width] + gray[i - 1] + gray[i + 1] + gray[i + width] - 4 * gray[i];

      sum += response;
      sumSquares += response * response;
      count += 1;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/** Rec. 709 luma, the same weighting the eye applies. */
function toGrayscale(data: Uint8ClampedArray, pixels: number): Float32Array {
  const gray = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    gray[i] = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  }
  return gray;
}

/**
 * Decodes the file, measures it, and returns everything wrong with it.
 * Browser-only: it needs `createImageBitmap` and a canvas.
 */
export async function inspectImageQuality(file: File): Promise<ImageQualityReport> {
  const bitmap = await createImageBitmap(file);

  try {
    const { width, height } = bitmap;
    const issues: ImageQualityIssue[] = [];

    const shortEdge = Math.min(width, height);
    const longEdge = Math.max(width, height);

    if (shortEdge < MIN_SHORT_EDGE_PX || longEdge < MIN_LONG_EDGE_PX) {
      issues.push({
        code: 'low_resolution',
        message: `This image is small (${width}×${height}). Price labels and candles may be too coarse to read accurately.`,
      });
    }

    if (shortEdge > 0 && longEdge / shortEdge > MAX_ASPECT_RATIO) {
      issues.push({
        code: 'odd_shape',
        message:
          "This image is an unusually narrow strip, so it may be a crop rather than a full chart. Make sure the price axis and the candles are both in frame.",
      });
    }

    // Resample to the fixed sample size — upscaling a small image included,
    // since the score is only meaningful when every image is measured at the
    // same resolution.
    const scale = SAMPLE_EDGE_PX / longEdge;
    const sampleWidth = Math.max(1, Math.round(width * scale));
    const sampleHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { issues, width, height, sharpness: Number.NaN };

    ctx.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
    const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);

    const gray = toGrayscale(data, sampleWidth * sampleHeight);
    const sharpness = laplacianVariance(gray, sampleWidth, sampleHeight);

    if (sharpness < MIN_SHARPNESS) {
      issues.push({
        code: 'blurry',
        message:
          'This image looks blurry or soft. Photos of a screen and re-shared images lose the detail needed to read exact price levels.',
      });
    }

    return { issues, width, height, sharpness };
  } finally {
    bitmap.close();
  }
}
