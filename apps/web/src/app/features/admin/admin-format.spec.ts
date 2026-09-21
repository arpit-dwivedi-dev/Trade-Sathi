import { describe, expect, it } from 'vitest';

import { pnlIn } from './admin-format';

describe('pnlIn', () => {
  it('converts USD AI cost into rupees against INR revenue', () => {
    // ₹1,836 revenue, $0.7655 cost at ₹88/$ → 1836 − 67.364
    expect(pnlIn({ INR: 183600 }, 0.7655, 88, 'INR')).toBeCloseTo(1768.636, 3);
  });

  it('converts INR revenue into dollars', () => {
    expect(pnlIn({ INR: 183600 }, 0.7655, 88, 'USD')).toBeCloseTo(20.8636 - 0.7655, 3);
  });

  it('adds revenue from both currencies in the target currency', () => {
    expect(pnlIn({ INR: 8800, USD: 100 }, 0, 88, 'USD')).toBeCloseTo(2, 6);
  });

  it('needs no rate when everything is already in the target currency', () => {
    expect(pnlIn({ USD: 500 }, 1, null, 'USD')).toBe(4);
  });

  it('returns null rather than guessing when a rate is missing', () => {
    expect(pnlIn({ INR: 100 }, 0, null, 'USD')).toBeNull();
    expect(pnlIn({}, 1, null, 'INR')).toBeNull();
  });

  it('returns null when the AI cost is unknown', () => {
    expect(pnlIn({ INR: 100 }, null, 88, 'INR')).toBeNull();
  });
});
