import { NgTemplateOutlet, isPlatformBrowser } from '@angular/common';
import {
  Component,
  OnDestroy,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ChipModule } from 'primeng/chip';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectButtonModule } from 'primeng/selectbutton';

import type { FundamentalsAnnualPeriod, InstrumentFundamentals } from '@chartanalyzer/shared';
import { AppIcon } from '../../shared/icons/app-icon';
import type { SymbolSelection } from '../../shared/symbol-search/symbol-search';
import type { AnalysisRow } from '../analyze/analysis.types';
import { FundamentalsAnalysisResultComponent } from './fundamentals-analysis-result';
import { FundamentalsService, type FundamentalsPollHandle } from './fundamentals.service';

/** State of the "Analyze with AI" run, independent of the raw-data load above it. */
type AiState =
  | 'idle'
  | 'queued'
  | 'complete'
  | 'failed'
  | 'quota_exceeded'
  | 'timed_out'
  | 'poll_error';

/** A label/value pair as rendered in the figure lists. */
interface Figure {
  label: string;
  value: string;
  /** Marks a value the eye should read as good/bad — growth, not a ratio. */
  tone?: 'up' | 'down';
}

/** A margin or return drawn as a bar as well as a number. */
interface Ratio {
  label: string;
  /** Fraction, or null when the company does not report it. */
  value: number | null;
  /** Bar fill, 0-100. */
  fill: number;
}

/** The series the annual chart and table can be switched between. */
const ANNUAL_METRICS = [
  { key: 'revenue', label: 'Revenue', money: true },
  { key: 'operatingIncome', label: 'Operating income', money: true },
  { key: 'netIncome', label: 'Net income', money: true },
  { key: 'dilutedEps', label: 'Diluted EPS', money: false },
] as const;

type AnnualMetric = (typeof ANNUAL_METRICS)[number]['key'];

/**
 * Margins and returns are drawn as bars, and a bar needs a full-scale value.
 * A margin is a share of revenue, so its own natural ceiling is the honest
 * one: the bar then reads as how much of each unit of revenue the company
 * keeps. A generous 50% ceiling was tried first and was worse — every margin
 * a strong company reports clears it, so a whole card of bars sat pinned at
 * full width, differing in their numbers and not in the picture. A return on
 * equity can exceed 100% and is clamped, which costs the comparison nothing:
 * past the full track the number is the reading.
 */
const RATIO_FULL_SCALE = 1;

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

/**
 * Reads a company rather than a chart: what the market is paying for it, what
 * it earns, what it owes, and how those figures have moved over the reported
 * years.
 *
 * Every number here is sparse by nature — a bank publishes no gross margin, a
 * loss-making company no trailing P/E — so a missing figure is drawn as a dash
 * and never as an error. See the fundamentals contract in packages/shared.
 *
 * Like the chart tabs, this screen has no search of its own: the instrument
 * arrives from the shell's top-bar search (see AppPage's topbar).
 */
@Component({
  selector: 'app-fundamentals-page',
  imports: [
    NgTemplateOutlet,
    FormsModule,
    FundamentalsAnalysisResultComponent,
    AppIcon,
    ButtonModule,
    CardModule,
    ChipModule,
    ProgressSpinnerModule,
    SelectButtonModule,
  ],
  templateUrl: './fundamentals-page.html',
  styleUrl: './fundamentals-page.css',
})
export class FundamentalsPage implements OnDestroy {
  private readonly fundamentals = inject(FundamentalsService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** The instrument to read, chosen in the shell's top-bar search. */
  readonly selection = input<SymbolSelection | null>(null);

  protected readonly annualMetrics = ANNUAL_METRICS;
  // p-selectButton's [options] wants a mutable array, so this is a shallow
  // copy of the readonly module-level constant above.
  protected readonly annualMetricOptions = [...ANNUAL_METRICS];

  protected readonly data = signal<InstrumentFundamentals | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly annualMetric = signal<AnnualMetric>('revenue');
  protected readonly summaryOpen = signal(false);

  /**
   * Bumped on every load() call so a stale response can be dropped even when
   * it is for the same instrument id as the request that superseded it (the
   * same symbol can be selected twice in a row — see the effect below).
   */
  private requestSeq = 0;

  /* ── Analyze with AI ─────────────────────────────────────── */

  protected readonly aiState = signal<AiState>('idle');
  protected readonly aiRow = signal<AnalysisRow | null>(null);
  protected readonly aiError = signal<string | null>(null);
  private aiPoll: FundamentalsPollHandle | null = null;

  constructor() {
    // Reads whatever the shell hands down, including the same symbol picked
    // twice in a row — see SymbolSelection's requestId for why that still
    // fires here.
    effect(() => {
      const selection = this.selection();
      if (!this.isBrowser || !selection) return;
      void this.load(selection.instrument.id);
    });
  }

  protected async reload(): Promise<void> {
    const id = this.data()?.instrument.id ?? this.selection()?.instrument.id;
    if (id) await this.load(id);
  }

  private async load(instrumentId: string): Promise<void> {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set(null);
    // The previous company's figures are dropped up front: they are labelled
    // with their own symbol elsewhere on the page, and leaving them on screen
    // under a new header would read as this company's numbers.
    this.data.set(null);
    this.summaryOpen.set(false);
    // A new symbol owns the AI panel too — an in-flight run or a finished
    // read for the company just left the screen must not linger under one
    // that has nothing to do with it.
    this.resetAi();

    const result = await this.fundamentals.fetchFundamentals(instrumentId);
    // A later load — even for this same instrument id — owns the screen now.
    if (seq !== this.requestSeq) return;

    this.loading.set(false);
    if (result.ok) this.data.set(result.fundamentals);
    else this.error.set(result.message);
  }

  private resetAi(): void {
    this.aiPoll?.cancel();
    this.aiPoll = null;
    this.aiState.set('idle');
    this.aiRow.set(null);
    this.aiError.set(null);
  }

  protected async analyzeWithAi(): Promise<void> {
    const instrumentId = this.data()?.instrument.id;
    if (!instrumentId || this.aiState() === 'queued') return;

    this.aiState.set('queued');
    this.aiError.set(null);
    this.aiRow.set(null);

    const submitted = await this.fundamentals.analyzeWithAi(instrumentId);
    if (!submitted.ok) {
      this.aiError.set(submitted.message);
      this.aiState.set(submitted.reason === 'quota_exceeded' ? 'quota_exceeded' : 'failed');
      return;
    }

    const handle = this.fundamentals.pollFundamentalsAnalysis(submitted.id, (row) =>
      this.aiRow.set(row),
    );
    this.aiPoll = handle;

    void handle.result.then((outcome) => {
      this.aiPoll = null;
      switch (outcome.outcome) {
        case 'complete':
          this.aiRow.set(outcome.row);
          this.aiState.set('complete');
          break;
        case 'failed':
          this.aiRow.set(outcome.row);
          this.aiState.set('failed');
          break;
        case 'timed_out':
          this.aiState.set('timed_out');
          break;
        case 'poll_error':
          this.aiState.set('poll_error');
          break;
      }
    });
  }

  ngOnDestroy(): void {
    // Without this the row watch keeps firing after the user navigates away,
    // and would try to update a destroyed component's state.
    this.aiPoll?.cancel();
    this.aiPoll = null;
  }

  // ── formatting ────────────────────────────────────────────

  /** The statement currency, which is the one every money figure below is in. */
  private currencySymbol(): string {
    const code = this.data()?.meta.financialCurrency ?? this.data()?.meta.currency ?? '';
    return CURRENCY_SYMBOLS[code] ?? (code ? `${code} ` : '');
  }

  /**
   * Money at company scale, so it is always compacted: a market cap is a
   * 13-digit number in rupees, and the digits past the third carry no
   * information a reader of this screen wants.
   */
  protected money(value: number | null): string {
    if (value === null) return '—';
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    const symbol = this.currencySymbol();
    for (const [limit, suffix] of [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ] as const) {
      if (abs >= limit) return `${sign}${symbol}${(abs / limit).toFixed(2)}${suffix}`;
    }
    return `${sign}${symbol}${abs.toFixed(2)}`;
  }

  /** A per-share or per-unit price, which is read to the paisa/cent. */
  protected price(value: number | null): string {
    if (value === null) return '—';
    return `${this.currencySymbol()}${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  /** A plain count — shares, employees, traded volume. */
  protected count(value: number | null): string {
    if (value === null) return '—';
    const abs = Math.abs(value);
    for (const [limit, suffix] of [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ] as const) {
      if (abs >= limit) return `${(value / limit).toFixed(2)}${suffix}`;
    }
    return value.toLocaleString();
  }

  /**
   * A count read in full rather than compacted — a headcount is a fact about
   * the company, and "150.00K employees" is a worse reading of it than
   * "150,000".
   */
  protected whole(value: number | null): string {
    return value === null ? '—' : Math.round(value).toLocaleString();
  }

  protected ratio(value: number | null): string {
    return value === null ? '—' : value.toFixed(2);
  }

  /** A fraction as a percentage — the form every margin, yield and growth is stored in. */
  protected percent(value: number | null): string {
    return value === null ? '—' : `${(value * 100).toFixed(2)}%`;
  }

  protected signedPercent(value: number | null): string {
    if (value === null) return '—';
    return `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
  }

  private tone(value: number | null): 'up' | 'down' | undefined {
    if (value === null || value === 0) return undefined;
    return value > 0 ? 'up' : 'down';
  }

  // ── derived views ─────────────────────────────────────────

  /** Direction of the day's move, which colours the price readout. */
  protected readonly changeTone = computed(() => this.tone(this.data()?.snapshot.change ?? null));

  /** The headline readings, as the four tiles across the top. */
  protected readonly tiles = computed<Figure[]>(() => {
    const data = this.data();
    if (!data) return [];
    return [
      { label: 'Market cap', value: this.money(data.snapshot.marketCap) },
      { label: 'P/E (trailing)', value: this.ratio(data.valuation.trailingPe) },
      { label: 'EPS (trailing)', value: this.price(data.valuation.trailingEps) },
      { label: 'Dividend yield', value: this.percent(data.valuation.dividendYield) },
    ];
  });

  protected readonly valuationFigures = computed<Figure[]>(() => {
    const data = this.data();
    if (!data) return [];
    const { valuation } = data;
    return [
      { label: 'P/E (trailing)', value: this.ratio(valuation.trailingPe) },
      { label: 'P/E (forward)', value: this.ratio(valuation.forwardPe) },
      { label: 'PEG ratio', value: this.ratio(valuation.pegRatio) },
      { label: 'Price / book', value: this.ratio(valuation.priceToBook) },
      { label: 'Price / sales', value: this.ratio(valuation.priceToSales) },
      { label: 'EV / revenue', value: this.ratio(valuation.enterpriseToRevenue) },
      { label: 'EV / EBITDA', value: this.ratio(valuation.enterpriseToEbitda) },
      { label: 'Enterprise value', value: this.money(valuation.enterpriseValue) },
      { label: 'Book value / share', value: this.price(valuation.bookValue) },
      { label: 'EPS (forward)', value: this.price(valuation.forwardEps) },
      { label: 'Dividend / share', value: this.price(valuation.dividendRate) },
      { label: 'Payout ratio', value: this.percent(valuation.payoutRatio) },
      { label: 'Beta', value: this.ratio(valuation.beta) },
    ];
  });

  /**
   * Margins and returns as one group. They answer the same question — what
   * the company earns on what it takes in and on what it employs — and they
   * are drawn the same way, so the screen shows them as one set of bars
   * rather than two lists that happen to look alike.
   */
  protected readonly profitabilityRatios = computed<Ratio[]>(() => {
    const profitability = this.data()?.profitability;
    if (!profitability) return [];
    return [
      { label: 'Gross margin', value: profitability.grossMargin },
      { label: 'Operating margin', value: profitability.operatingMargin },
      { label: 'EBITDA margin', value: profitability.ebitdaMargin },
      { label: 'Net profit margin', value: profitability.profitMargin },
      { label: 'Return on equity', value: profitability.returnOnEquity },
      { label: 'Return on assets', value: profitability.returnOnAssets },
    ].map((row) => ({
      ...row,
      fill:
        row.value === null
          ? 0
          : Math.min(100, Math.max(0, (row.value / RATIO_FULL_SCALE) * 100)),
    }));
  });

  protected readonly growthFigures = computed<Figure[]>(() => {
    const data = this.data();
    if (!data) return [];
    const { revenueGrowth, earningsGrowth, earningsQuarterlyGrowth } = data.growth;
    return [
      {
        label: 'Revenue growth (yoy)',
        value: this.signedPercent(revenueGrowth),
        tone: this.tone(revenueGrowth),
      },
      {
        label: 'Earnings growth (yoy)',
        value: this.signedPercent(earningsGrowth),
        tone: this.tone(earningsGrowth),
      },
      {
        label: 'Quarterly earnings growth',
        value: this.signedPercent(earningsQuarterlyGrowth),
        tone: this.tone(earningsQuarterlyGrowth),
      },
    ];
  });

  protected readonly healthFigures = computed<Figure[]>(() => {
    const data = this.data();
    if (!data) return [];
    const { health } = data;
    return [
      { label: 'Revenue (ttm)', value: this.money(health.totalRevenue) },
      { label: 'EBITDA', value: this.money(health.ebitda) },
      { label: 'Net income', value: this.money(health.netIncome) },
      { label: 'Total cash', value: this.money(health.totalCash) },
      { label: 'Total debt', value: this.money(health.totalDebt) },
      { label: 'Debt / equity', value: this.ratio(health.debtToEquity) },
      { label: 'Current ratio', value: this.ratio(health.currentRatio) },
      { label: 'Quick ratio', value: this.ratio(health.quickRatio) },
      { label: 'Operating cash flow', value: this.money(health.operatingCashflow) },
      { label: 'Free cash flow', value: this.money(health.freeCashflow) },
      { label: 'Shares outstanding', value: this.count(health.sharesOutstanding) },
    ];
  });

  protected readonly tradingFigures = computed<Figure[]>(() => {
    const data = this.data();
    if (!data) return [];
    const { snapshot } = data;
    return [
      { label: 'Previous close', value: this.price(snapshot.previousClose) },
      {
        label: "Day's range",
        value:
          snapshot.dayLow === null || snapshot.dayHigh === null
            ? '—'
            : `${this.price(snapshot.dayLow)} – ${this.price(snapshot.dayHigh)}`,
      },
      { label: '50-day average', value: this.price(snapshot.fiftyDayAverage) },
      { label: '200-day average', value: this.price(snapshot.twoHundredDayAverage) },
      { label: 'Volume', value: this.count(snapshot.volume) },
      { label: 'Average volume', value: this.count(snapshot.averageVolume) },
    ];
  });

  /**
   * Where the last price sits inside the 52-week range, as a percentage along
   * the track. Null whenever the range itself is unreported or degenerate —
   * a marker at an arbitrary position would be a claim about the stock.
   */
  protected readonly rangePosition = computed<number | null>(() => {
    const snapshot = this.data()?.snapshot;
    if (!snapshot) return null;
    const { price, fiftyTwoWeekLow: low, fiftyTwoWeekHigh: high } = snapshot;
    if (price === null || low === null || high === null || high <= low) return null;
    return Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
  });

  /** The reported years, most recent first — the order a financials table is read in. */
  protected readonly annualRows = computed<FundamentalsAnnualPeriod[]>(() =>
    [...(this.data()?.annual ?? [])].reverse(),
  );

  protected readonly annualMetricLabel = computed(
    () => ANNUAL_METRICS.find((m) => m.key === this.annualMetric())?.label ?? '',
  );

  /**
   * The selected series as bars. Heights are shares of one track that
   * contains both the largest positive and the largest negative value, with
   * the zero line placed between them — a loss-making year has to be drawn
   * downwards, not clipped to nothing.
   */
  protected readonly annualBars = computed(() => {
    const metric = this.annualMetric();
    const money = ANNUAL_METRICS.find((m) => m.key === metric)?.money ?? true;
    const periods = this.data()?.annual ?? [];

    const values = periods
      .map((period) => period[metric])
      .filter((value): value is number => value !== null);
    if (values.length === 0) return [];

    const maxPositive = Math.max(0, ...values);
    const maxNegative = Math.max(0, ...values.map((value) => -value));
    const span = maxPositive + maxNegative;
    // Every reported year is zero — no scale to draw against, so no bars.
    if (span === 0) return [];

    return periods.map((period) => {
      const value = period[metric];
      return {
        year: period.asOfDate.slice(0, 4),
        asOfDate: period.asOfDate,
        label: money ? this.money(value) : this.price(value),
        /** Height of the bar itself, as a share of the whole track. */
        heightPct: value === null ? 0 : (Math.abs(value) / span) * 100,
        /** Distance from the bottom of the track to the bar's base. */
        basePct: value === null || value >= 0 ? (maxNegative / span) * 100 : 0,
        negative: value !== null && value < 0,
        missing: value === null,
      };
    });
  });

  /** Where the zero line sits in the track, so it can be drawn once. */
  protected readonly annualZeroPct = computed(() => this.annualBars()[0]?.basePct ?? 0);

  protected annualValue(period: FundamentalsAnnualPeriod, metric: AnnualMetric): string {
    const money = ANNUAL_METRICS.find((m) => m.key === metric)?.money ?? true;
    return money ? this.money(period[metric]) : this.price(period[metric]);
  }

  protected selectAnnualMetric(metric: AnnualMetric): void {
    this.annualMetric.set(metric);
  }

  protected toggleSummary(): void {
    this.summaryOpen.update((open) => !open);
  }
}
