import { TestBed } from '@angular/core/testing';

import type { InstrumentFundamentals } from '@tradesathi/shared';
import { FundamentalsPage } from './fundamentals-page';
import { FundamentalsService, type FundamentalsResult } from './fundamentals.service';

/**
 * A payload shaped like a real one: every section populated, and a few figures
 * left null the way the provider actually reports them (see the fundamentals
 * contract — a null is a normal reading, not an error).
 */
const FUNDAMENTALS: InstrumentFundamentals = {
  instrument: { id: 'i1', symbol: 'SSDL', name: 'Saraswati Saree Depot Ltd', exchange: 'NSE' },
  meta: {
    currency: 'INR',
    financialCurrency: 'INR',
    asOf: '2026-09-04T10:00:00.000Z',
    mostRecentQuarter: '2026-06-30',
  },
  profile: {
    sector: 'Consumer Cyclical',
    industry: 'Apparel Retail',
    employees: 526,
    website: null,
    summary: 'Sells sarees.',
  },
  snapshot: {
    price: 56.69,
    change: 0.77,
    changePercent: 0.0138,
    previousClose: 55.92,
    dayLow: 55.5,
    dayHigh: 57.2,
    fiftyTwoWeekLow: 46.15,
    fiftyTwoWeekHigh: 91.9,
    fiftyDayAverage: 60.1,
    twoHundredDayAverage: 65.4,
    volume: 120_000,
    averageVolume: 98_000,
    marketCap: 2_240_000_000,
  },
  valuation: {
    trailingPe: 9.45,
    forwardPe: null,
    pegRatio: null,
    priceToBook: 1.18,
    priceToSales: 0.35,
    enterpriseValue: 1_480_000_000,
    enterpriseToRevenue: 0.23,
    enterpriseToEbitda: 5.27,
    trailingEps: 6,
    forwardEps: null,
    bookValue: 47.86,
    dividendYield: 0.062,
    dividendRate: 3.79,
    payoutRatio: 0,
    beta: 1.16,
  },
  profitability: {
    grossMargin: 0.09689,
    operatingMargin: 0.04933,
    ebitdaMargin: 0.04425,
    profitMargin: 0.03732,
    returnOnEquity: null,
    returnOnAssets: null,
  },
  growth: { revenueGrowth: 0.019, earningsGrowth: 0.056, earningsQuarterlyGrowth: 0.04 },
  health: {
    totalRevenue: 6_339_800_064,
    ebitda: 280_517_504,
    netIncome: 236_590_000,
    totalCash: 699_459_968,
    totalDebt: 6_220_000,
    debtToEquity: 0.32,
    currentRatio: null,
    quickRatio: null,
    freeCashflow: null,
    operatingCashflow: null,
    sharesOutstanding: 39_599_800,
  },
  annual: [
    { asOfDate: '2023-03-31', revenue: 4_000_000_000, operatingIncome: 2e8, netIncome: 1.5e8, dilutedEps: 4.1, operatingCashflow: null, freeCashflow: null },
    { asOfDate: '2024-03-31', revenue: 5_000_000_000, operatingIncome: 2.4e8, netIncome: 1.9e8, dilutedEps: 5.2, operatingCashflow: null, freeCashflow: null },
    { asOfDate: '2025-03-31', revenue: 6_339_800_064, operatingIncome: 2.8e8, netIncome: 2.36e8, dilutedEps: 6.0, operatingCashflow: null, freeCashflow: null },
  ],
};

class StubFundamentalsService {
  fetchFundamentals(): Promise<FundamentalsResult> {
    return Promise.resolve({ ok: true, fundamentals: FUNDAMENTALS });
  }
}

async function renderWithSelection() {
  const fixture = TestBed.createComponent(FundamentalsPage);
  fixture.componentRef.setInput('selection', {
    instrument: {
      id: 'i1',
      exchange: 'NSE',
      symbol: 'SSDL',
      name: 'Saraswati Saree Depot Ltd',
      instrumentType: 'EQUITY',
    },
    requestId: 1,
  });
  await fixture.whenStable();
  return fixture;
}

describe('FundamentalsPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FundamentalsPage],
      providers: [{ provide: FundamentalsService, useClass: StubFundamentalsService }],
    }).compileComponents();
  });

  it('prompts for a symbol until one is chosen, with the AI action disabled', async () => {
    const fixture = TestBed.createComponent(FundamentalsPage);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.fund-placeholder')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.fund-ai')?.disabled).toBe(true);
  });

  /**
   * The regression this file exists for: every section below Valuation
   * rendered its header and no rows at all, while the API was returning a
   * fully populated payload.
   */
  it('renders every section once the figures arrive', async () => {
    const fixture = await renderWithSelection();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.textContent ?? '';

    expect(host.querySelector('.fund-placeholder')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.fund-ai')?.disabled).toBe(false);

    // Valuation — the section that was rendering.
    expect(text).toContain('P/E (trailing)');
    // Profitability (4 margin bars; return on equity/assets are plain
    // figures, not bars — see marginBars/returnFigures), growth, balance
    // sheet and trading — the sections that were not.
    expect(host.querySelectorAll('.fund-bar').length).toBe(4 + 3);
    expect(text).toContain('Gross margin');
    expect(text).toContain('Return on equity');
    expect(text).toContain('Revenue growth');
    expect(text).toContain('Shares outstanding');
    expect(text).toContain("50-day average");
    // Reported years, which was not rendering either.
    expect(host.querySelectorAll('.fund-tbl-wrap tbody tr').length).toBe(3);
  });

  it('draws a dash for a figure the provider does not report', async () => {
    const fixture = await renderWithSelection();
    const host = fixture.nativeElement as HTMLElement;

    // returnOnEquity is null above; it must still read as a dash rather than
    // being dropped from the card.
    const figures = [...host.querySelectorAll('.fund-figure')];
    const roe = figures.find((figure) => figure.textContent?.includes('Return on equity'));

    expect(roe?.textContent).toContain('—');
  });
});
