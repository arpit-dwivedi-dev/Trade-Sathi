import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PricingOverview, UpiOrder } from '@tradesathi/shared';

import { BillingService, type FetchUpiOrderResult } from './billing.service';
import { BuyCreditsButton, formatCountdown, formatExactRupees } from './buy-credits-button';

const NOW = new Date('2026-11-07T10:00:00Z').getTime();

const PRICING: PricingOverview = {
  pricing: {
    region: 'IN',
    currency: 'INR',
    pricePerCreditMinor: 900,
    minPurchaseCredits: 25,
    maxPurchaseCredits: 500,
    purchaseIncrementCredits: 5,
    quickAmountsMinor: [],
  },
  featureCosts: [],
  purchasesEnabled: true,
};

const ORDER: UpiOrder = {
  orderId: 'order-1',
  reference: 'TSUABCD2345',
  status: 'pending',
  amountMinor: 22499,
  currency: 'INR',
  creditsRequested: 25,
  expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
  settleDeadline: new Date(NOW + 35 * 60_000).toISOString(),
  payment: {
    upiUri: 'upi://pay?pa=owner@xmpl&pn=TradeSathi&am=224.99&cu=INR&tn=TradeSathi%20TSUABCD2345',
    qrDataUrl: 'data:image/png;base64,AAAA',
    payeeName: 'TradeSathi',
    payeeVpa: 'owner@xmpl',
  },
};

function fakeBilling(pending: string | null = null) {
  const pricing = signal<PricingOverview | null>(PRICING);
  return {
    pricing: pricing.asReadonly(),
    ensurePricing: vi.fn(() => Promise.resolve(PRICING)),
    createUpiOrder: vi.fn(() => Promise.resolve({ ok: true as const, order: ORDER })),
    fetchUpiOrder: vi.fn<(id: string, withQr?: boolean) => Promise<FetchUpiOrderResult>>(() =>
      Promise.resolve({ ok: true, order: { ...ORDER, payment: null } }),
    ),
    rememberPendingUpiOrder: vi.fn(),
    forgetPendingUpiOrder: vi.fn(),
    readPendingUpiOrder: vi.fn(() => pending),
    refreshCreditBalance: vi.fn(() => Promise.resolve(25)),
  };
}

async function render(billing = fakeBilling()) {
  TestBed.configureTestingModule({
    imports: [BuyCreditsButton],
    providers: [provideRouter([]), { provide: BillingService, useValue: billing }],
  });
  const fixture = TestBed.createComponent(BuyCreditsButton);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  return { fixture, el, billing, settle };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formatting', () => {
  it('always shows paise, since they identify the order', () => {
    expect(formatExactRupees(22499)).toBe('₹224.99');
    expect(formatExactRupees(22500)).toBe('₹225.00');
    expect(formatExactRupees(10000000)).toBe('₹1,00,000.00');
  });

  it('counts down in m:ss and stops at zero', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(900_000)).toBe('15:00');
    expect(formatCountdown(-5_000)).toBe('0:00');
  });
});

describe('BuyCreditsButton', () => {
  it('shows the QR and exact amount, then reports the purchase once the API says paid', async () => {
    const { el, billing, settle } = await render();

    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle();

    expect(billing.createUpiOrder).toHaveBeenCalledWith(25, undefined);
    expect(billing.rememberPendingUpiOrder).toHaveBeenCalledWith(ORDER);
    expect(el.textContent).toContain('₹224.99');
    expect(el.querySelector<HTMLImageElement>('img.upi-qr')!.src).toBe(ORDER.payment!.qrDataUrl);
    expect(el.querySelector<HTMLAnchorElement>('a.upi-app')!.getAttribute('href')).toBe(ORDER.payment!.upiUri);
    expect(el.textContent).toContain('15:00');
    expect(el.textContent).toContain('TSUABCD2345');

    // Still pending on the first poll: nothing changes, polling continues.
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(billing.fetchUpiOrder).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Waiting for your payment');
    expect(el.textContent).toContain('14:57');

    billing.fetchUpiOrder.mockResolvedValueOnce({ ok: true, order: { ...ORDER, status: 'paid', payment: null } });
    await vi.advanceTimersByTimeAsync(3000);
    await settle();

    expect(el.textContent).toContain('Credits added');
    expect(billing.forgetPendingUpiOrder).toHaveBeenCalled();
    expect(billing.refreshCreditBalance).toHaveBeenCalled();

    // Settled: no more polling.
    const calls = billing.fetchUpiOrder.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(billing.fetchUpiOrder.mock.calls.length).toBe(calls);
  });

  it('keeps waiting after the QR expires, then says no payment arrived after the deadline', async () => {
    const { el, billing, settle } = await render();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle();

    vi.setSystemTime(NOW + 16 * 60_000);
    billing.fetchUpiOrder.mockResolvedValueOnce({ ok: true, order: { ...ORDER, status: 'expired', payment: null } });
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(el.textContent).toContain('This QR has expired');

    vi.setSystemTime(NOW + 36 * 60_000);
    billing.fetchUpiOrder.mockResolvedValueOnce({ ok: true, order: { ...ORDER, status: 'expired', payment: null } });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(el.textContent).toContain("We didn't receive a payment for order TSUABCD2345");
    expect(billing.forgetPendingUpiOrder).toHaveBeenCalled();
  });

  it('shows the API refusal and offers to try again', async () => {
    const billing = fakeBilling();
    billing.createUpiOrder.mockResolvedValueOnce({
      ok: false,
      reason: 'rejected',
      message: 'A purchase must be at least 25 credits',
    } as never);
    const { el, settle } = await render(billing);

    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle();
    expect(el.textContent).toContain('A purchase must be at least 25 credits');
    expect(billing.rememberPendingUpiOrder).not.toHaveBeenCalled();
  });

  it('resumes a remembered order after a reload, QR and all', async () => {
    const billing = fakeBilling('order-1');
    billing.fetchUpiOrder.mockResolvedValueOnce({ ok: true, order: ORDER });
    const { el, settle } = await render(billing);
    await settle();

    expect(billing.fetchUpiOrder).toHaveBeenCalledWith('order-1', true);
    expect(el.querySelector('img.upi-qr')).not.toBeNull();
    expect(el.textContent).toContain('₹224.99');
  });
});
