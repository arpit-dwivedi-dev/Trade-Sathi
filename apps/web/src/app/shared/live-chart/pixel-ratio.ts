/**
 * Runs `fn` with the chart library believing the screen is `ratio`x dense,
 * so a chart built inside it paints its canvases at that many pixels per CSS
 * pixel — the same layout the user sees, just sharper.
 *
 * KLineChart reads `window.devicePixelRatio` when it sizes a canvas, which is
 * what the override feeds. But on browsers that support it, it also watches
 * each canvas with a ResizeObserver and takes the real device-pixel size off
 * the entry, which would repaint the chart back down a frame later. Observers
 * created in the meantime get entries without that size: the library then
 * finds none, ignores the entry, and keeps the ratio it was given. They are
 * otherwise ordinary observers, so anything else created during the window
 * still works.
 *
 * Only for charts that are thrown away inside `fn`: a chart created here
 * keeps the stripped observer for life.
 */
export async function withPixelRatio<T>(ratio: number, fn: () => Promise<T>): Promise<T> {
  const ownRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  const NativeObserver = window.ResizeObserver;

  class ContentBoxObserver extends NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) =>
        callback(
          entries.map((entry) => ({
            target: entry.target,
            contentRect: entry.contentRect,
            contentBoxSize: entry.contentBoxSize,
            borderBoxSize: entry.borderBoxSize,
            devicePixelContentBoxSize: [],
          })),
          observer,
        ),
      );
    }

    override observe(target: Element, options?: ResizeObserverOptions): void {
      super.observe(target, options?.box === 'device-pixel-content-box' ? { box: 'content-box' } : options);
    }
  }

  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => ratio });
  window.ResizeObserver = ContentBoxObserver;
  try {
    return await fn();
  } finally {
    window.ResizeObserver = NativeObserver;
    if (ownRatio) Object.defineProperty(window, 'devicePixelRatio', ownRatio);
    else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
  }
}
