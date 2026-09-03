import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FONT_MONO, FONT_UI } from './typography';

/**
 * The stacks exist twice — once in Sass for the DOM, once in TypeScript for
 * the canvas renderers — because neither language can read the other's. This
 * reads the Sass back and compares, so the duplication cannot rot into two
 * different fonts on the same screen.
 */
describe('font stacks', () => {
  // Off cwd rather than import.meta.url: the spec is bundled before it runs,
  // so its own URL is not a path on disk. The test runner's cwd is the
  // package root.
  const scss = readFileSync(resolve(process.cwd(), 'src/styles/_typography.scss'), 'utf8');

  /** Sass wraps its lists over many lines; the strings are a single line. */
  const stack = (name: string): string => {
    const match = new RegExp(`\\$${name}:([^;]*);`).exec(scss);
    expect(match).not.toBeNull();
    return match![1].replace(/\s+/g, ' ').trim();
  };

  it('keeps $font-ui and FONT_UI identical', () => {
    expect(stack('font-ui')).toBe(FONT_UI);
  });

  it('keeps $font-mono and FONT_MONO identical', () => {
    expect(stack('font-mono')).toBe(FONT_MONO);
  });
});
