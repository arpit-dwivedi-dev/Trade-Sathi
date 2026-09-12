/**
 * jsdom's `HTMLCanvasElement.getContext()` returns null without the native
 * `canvas` package installed, and neither Chart.js (Fundamentals' charts) nor
 * lottie-web's own load-time feature probe null-checks it before writing to
 * the context — so any spec that mounts one of those crashes before a single
 * assertion runs. A real `canvas` package buys pixel-accurate rendering no
 * spec here asserts on; a fake context that accepts every call is enough to
 * let both libraries initialize without crashing.
 *
 * Wired in as a global Vitest `setupFiles` entry (angular.json's `test`
 * target), which the unit-test builder runs before any spec file's own
 * imports — a spec-local import arrives too late, since lottie-web probes
 * canvas support at module-evaluation time, before a spec's `beforeEach` (or
 * even its own top-level statements after the import that pulls lottie-web
 * in) gets a chance to run.
 */
const fakeContext = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: () => {} });
      }
      return () => fakeContext;
    },
    set: () => true,
  },
);

// A plain assignment needs a cast through `any` (canvas.getContext's real
// overloads don't cover a test double), which then reads as unsafe member
// access — defineProperty sidesteps both by taking the replacement as an
// untyped value.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => fakeContext,
});
