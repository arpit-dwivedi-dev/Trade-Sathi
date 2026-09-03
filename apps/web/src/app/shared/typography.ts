/**
 * The UI font stack, as a canvas-ready string.
 *
 * CSS cannot reach a <canvas>: KLineChart and the PNG capture both take a
 * font family as a plain string and resolve it themselves, so the chart's
 * axis labels would silently keep whatever default the library ships unless
 * the stack is handed to it in JS.
 *
 * This is the same list as $font-ui in ../../styles/_typography.scss, and
 * typography.spec.ts parses that file to prove the two have not drifted.
 */
export const FONT_UI =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, Cantarell, 'Noto Sans', Arial, sans-serif";

/** The monospace stack, mirroring $font-mono. Same contract as FONT_UI. */
export const FONT_MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Cascadia Code', 'Liberation Mono', 'DejaVu Sans Mono', monospace";
