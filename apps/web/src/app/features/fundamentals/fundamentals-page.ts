import { DOCUMENT, NgTemplateOutlet, isPlatformBrowser } from '@angular/common';
import {
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ChartModule } from 'primeng/chart';
import { ChipModule } from 'primeng/chip';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';

import type { FundamentalsAnnualPeriod, InstrumentFundamentals } from '@tradesathi/shared';
import { AuthService } from '../../core/auth.service';
import {
  clearPendingAnalysis,
  loadPendingAnalysis,
  savePendingAnalysis,
} from '../../core/pending-analysis-store';
import { ThemeService } from '../../core/theme.service';
import { AppIcon } from '../../shared/icons/app-icon';
import { LottiePlayer } from '../../shared/lottie-player';
import type { SymbolSelection } from '../../shared/symbol-search/symbol-search';
import type { AnalysisRow } from '../analyze/analysis.types';
import { AnalyzeService } from '../analyze/analyze.service';
import { BetaCredits } from '../billing/beta-credits';
import { BillingService } from '../billing/billing.service';
import { PURCHASES_ENABLED } from '../billing/free-beta';
import { FundamentalsAnalysisResultComponent } from './fundamentals-analysis-result';
import { FundamentalsService, type FundamentalsPollHandle } from './fundamentals.service';
import { loadLastCompany, saveLastCompany, type LastCompany } from './last-company-store';

/** State of the "Analyze with AI" run, independent of the raw-data load above it. */
type AiState =
  | 'idle'
  /**
   * Only ever set during a reload, while it is still unknown whether a run is
   * in flight for the restored company. Renders nothing — it exists to hold
   * the Analyse button disabled so a second (charged) run cannot be started
   * on top of one that is about to be adopted.
   */
  | 'restoring'
  | 'queued'
  | 'complete'
  | 'failed'
  | 'insufficient_credits'
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

/** A year-on-year growth figure, drawn as a bar against a shared ceiling. */
interface GrowthBar {
  label: string;
  display: string;
  tone: 'up' | 'down' | undefined;
  fill: number;
}

/**
 * The series the annual chart and table can be switched between. `short` is
 * what the picker shows on a phone, where the four full labels do not fit.
 */
const ANNUAL_METRICS = [
  { key: 'revenue', label: 'Revenue', short: 'Revenue', money: true },
  { key: 'operatingIncome', label: 'Operating income', short: 'Op. income', money: true },
  { key: 'netIncome', label: 'Net income', short: 'Net income', money: true },
  { key: 'dilutedEps', label: 'Diluted EPS', short: 'EPS', money: false },
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

/**
 * Growth is unbounded in principle but reads as a bar against a shared
 * ceiling: a company doubling revenue and one growing 6% both need to fit on
 * the same three-row track, and 40% is generous enough that a strong quarter
 * still has room to grow beyond it (clamped, same trade as returns above).
 */
const GROWTH_BAR_CEILING = 0.4;

/** The suffix ladder every compacted money figure and chart axis is read against. */
const MONEY_SCALE = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
] as const;

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

/** Resolved theme colors a Chart.js canvas needs as literal strings, not CSS custom properties. */
interface ChartPalette {
  acc: string;
  up: string;
  down: string;
  tx2: string;
  tx3: string;
  lineSoft: string;
}

const FALLBACK_PALETTE: ChartPalette = {
  acc: '#2962ff',
  up: '#089981',
  down: '#f23645',
  tx2: '#50535e',
  tx3: '#787b86',
  lineSoft: '#eef0f6',
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
    BetaCredits,
    ButtonModule,
    CardModule,
    ChartModule,
    ChipModule,
    LottiePlayer,
    ProgressSpinnerModule,
    RouterLink,
    SelectButtonModule,
    TableModule,
  ],
  templateUrl: './fundamentals-page.html',
  styleUrl: './fundamentals-page.css',
})
export class FundamentalsPage implements OnInit, OnDestroy {
  private readonly fundamentals = inject(FundamentalsService);
  private readonly analyses = inject(AnalyzeService);
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly document = inject(DOCUMENT);
  private readonly themeService = inject(ThemeService);

  /**
   * "Costs N credits", read from the centrally configured feature cost list
   * rather than hardcoded — this screen has no opinion of its own on what a
   * fundamentals analysis costs. Null until pricing has loaded.
   */
  protected readonly aiCostLabel = computed(() => {
    const cost = this.billing
      .pricing()
      ?.featureCosts.find((row) => row.featureKey === 'fundamental_analysis');
    if (!cost) return null;
    return `Costs ${cost.credits} credit${cost.credits === 1 ? '' : 's'}`;
  });

  /** The instrument to read, chosen in the shell's top-bar search. */
  readonly selection = input<SymbolSelection | null>(null);

  /**
   * Reopened a company from storage after a reload. The search box is the only
   * place the chosen symbol is spelled out, and it starts every page load
   * empty, so the shell labels it to match. No selection comes back — this
   * screen already has the company open.
   */
  readonly companyRestored = output<LastCompany['instrument']>();

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

  /**
   * The company currently owning the screen, set the moment it is opened
   * rather than when its figures land. `data()` cannot stand in for it: the
   * fetch takes a round trip, and the restore path needs to know what it is
   * looking at before that returns.
   */
  private openInstrumentId: string | null = null;

  /* ── Analyze with AI ─────────────────────────────────────── */

  protected readonly aiState = signal<AiState>('idle');
  protected readonly aiRow = signal<AnalysisRow | null>(null);
  protected readonly aiError = signal<string | null>(null);
  /** Off for the free beta (see PURCHASES_ENABLED): out of credits offers the beta code. */
  protected readonly purchasesEnabled = PURCHASES_ENABLED;
  /**
   * The id of the AI run being polled, known as soon as it's submitted. The
   * "view report" link is driven by this rather than `aiRow`, since `aiRow`
   * only fills in once a poll tick returns a row and shouldn't gate the link.
   */
  protected readonly aiAnalysisId = signal<string | null>(null);
  private aiPoll: FundamentalsPollHandle | null = null;

  constructor() {
    // Reads whatever the shell hands down, including the same symbol picked
    // twice in a row — see SymbolSelection's requestId for why that still
    // fires here.
    effect(() => {
      const selection = this.selection();
      if (!this.isBrowser || !selection) return;
      this.openCompany(selection.instrument);
    });

    // For the "Costs N credits" label — the shell already loads this on
    // mount, so this shares that cache rather than adding a request.
    void this.billing.ensurePricing();
  }

  ngOnInit(): void {
    if (this.isBrowser) this.restoreCompany();
  }

  /**
   * Opens one company: remembered first, then loaded. Shared by a pick from
   * the shell's search and by a reload restore, so both take the same path.
   */
  private openCompany(instrument: LastCompany['instrument']): void {
    this.openInstrumentId = instrument.id;
    saveLastCompany(this.isBrowser, {
      instrument: {
        id: instrument.id,
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        logoUrl: instrument.logoUrl,
      },
    });
    void this.load(instrument.id);
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

  /** The beta code was redeemed from the out-of-credits card, so the AI run can be asked for again. */
  protected onBetaRedeemed(): void {
    if (this.aiState() !== 'insufficient_credits') return;
    this.aiState.set('idle');
    this.aiError.set(null);
  }

  private resetAi(): void {
    this.aiPoll?.cancel();
    this.aiPoll = null;
    this.aiState.set('idle');
    this.aiRow.set(null);
    this.aiError.set(null);
    this.aiAnalysisId.set(null);
  }

  protected async analyzeWithAi(): Promise<void> {
    const instrumentId = this.data()?.instrument.id;
    if (!instrumentId || this.aiState() === 'queued') return;

    this.aiState.set('queued');
    this.aiError.set(null);
    this.aiRow.set(null);
    this.aiAnalysisId.set(null);

    const submitted = await this.fundamentals.analyzeWithAi(instrumentId);
    if (!submitted.ok) {
      this.aiError.set(submitted.message);
      this.aiState.set(
        submitted.reason === 'insufficient_credits' ? 'insufficient_credits' : 'failed',
      );
      return;
    }

    // Remembered before the wait starts, so a reload mid-run can pick the same
    // row back up instead of losing a run that is already charged and running.
    savePendingAnalysis(this.isBrowser, 'fundamentals', {
      id: submitted.id,
      startedAt: Date.now(),
    });

    this.watchRun(submitted.id);
  }

  /**
   * Watches one run to its outcome and puts it on screen.
   *
   * Shared by a run started here and one resumed after a reload: both are just
   * an analyses row id, and neither cares which page load started it.
   */
  private watchRun(analysisId: string): void {
    this.aiState.set('queued');
    this.aiAnalysisId.set(analysisId);

    const handle = this.fundamentals.pollFundamentalsAnalysis(analysisId, (row) =>
      this.aiRow.set(row),
    );
    this.aiPoll = handle;

    void handle.result.then((outcome) => {
      // A new company (or a cancel) took the panel while this was in flight.
      if (this.aiPoll !== handle) return;
      this.aiPoll = null;

      // Only a settled run stops being remembered. 'timed_out' means the
      // backend may still be working on it and 'poll_error' means this browser
      // could not read the row — neither says the run is over, so both stay
      // resumable.
      if (outcome.outcome === 'complete' || outcome.outcome === 'failed') {
        clearPendingAnalysis(this.isBrowser, 'fundamentals');
      }

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

  /**
   * Puts the tab back the way the user left it after a reload.
   *
   * Two things are restored, and neither survives a page load on its own: the
   * company (it comes from the shell's search as an input, which starts null
   * every load) and any AI run still going on it (charged and executed
   * server-side the moment it starts, so it must not look like nothing is
   * happening).
   *
   * Anything the shell hands down afterwards still wins — the selection effect
   * in the constructor calls openCompany in its own right.
   */
  private restoreCompany(): void {
    // The shell can hand a company down before this pane is first mounted —
    // "open in Fundamentals" from History sets the input, then switches tab.
    // That pick is a deliberate one and outranks whatever was stored.
    if (this.selection()) return;

    const last = loadLastCompany(this.isBrowser);
    if (!last) return;

    const pending = loadPendingAnalysis(this.isBrowser, 'fundamentals');

    this.openCompany(last.instrument);
    this.companyRestored.emit(last.instrument);

    // After openCompany, whose resetAi() would otherwise put this back to
    // idle, and still before the first paint. A remembered run is known to be
    // going; without one it is not known yet, and 'restoring' holds the
    // Analyse button disabled — without claiming a run is going — until
    // adoptUnfinishedRun settles the question.
    this.aiState.set(pending ? 'queued' : 'restoring');

    // Awaited rather than read straight away: on a fresh page load the Supabase
    // session is restored asynchronously, and a read issued before it lands is
    // refused by RLS — which would look like a run that cannot be read when
    // nothing is wrong with it.
    void this.auth.whenRestored().then(() => {
      // The user picked another company from the search while the session was
      // being restored; that pick owns the panel now.
      if (this.selection()) return;
      if (pending) {
        this.watchRun(pending.id);
        return;
      }
      return this.adoptUnfinishedRun(last.instrument.id);
    });
  }

  /**
   * Re-attaches to a run this browser never got to remember.
   *
   * The row is created server-side before /api/market/fundamentals/analyze has
   * even responded, so a refresh in that window — the most likely moment for
   * one, since the user has just clicked and is watching — leaves a charged run
   * with no local record. The database is the authority on what is still
   * running, so it is asked directly, narrowed to this screen's own runs.
   */
  private async adoptUnfinishedRun(instrumentId: string): Promise<void> {
    const row = await this.analyses.findUnfinishedAnalysis(instrumentId, 'fundamentals');
    // The user may have started a run of their own, or moved on to another
    // company, while this was read.
    if (this.aiState() !== 'restoring' || this.openInstrumentId !== instrumentId) return;

    if (!row) {
      // Nothing running: release the button restoreCompany held disabled.
      this.aiState.set('idle');
      return;
    }

    savePendingAnalysis(this.isBrowser, 'fundamentals', {
      id: row.id,
      startedAt: Date.parse(row.created_at) || Date.now(),
    });
    this.watchRun(row.id);
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
    for (const [limit, suffix] of MONEY_SCALE) {
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
    for (const [limit, suffix] of MONEY_SCALE) {
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

  /** The divisor and suffix a set of money figures should be read against on a shared axis. */
  private moneyScaleFor(maxAbs: number): { divisor: number; suffix: string } {
    for (const [limit, suffix] of MONEY_SCALE) {
      if (maxAbs >= limit) return { divisor: limit, suffix };
    }
    return { divisor: 1, suffix: '' };
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

  /** Same reading as above, against the day's own low/high rather than the 52-week band. */
  protected readonly dayRangePosition = computed<number | null>(() => {
    const snapshot = this.data()?.snapshot;
    if (!snapshot) return null;
    const { price, dayLow: low, dayHigh: high } = snapshot;
    if (price === null || low === null || high === null || high <= low) return null;
    return Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
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

  /** The four margins, drawn as bars — what the company keeps of what it takes in. */
  protected readonly marginBars = computed<Ratio[]>(() => {
    const profitability = this.data()?.profitability;
    if (!profitability) return [];
    return [
      { label: 'Gross margin', value: profitability.grossMargin },
      { label: 'Operating margin', value: profitability.operatingMargin },
      { label: 'EBITDA margin', value: profitability.ebitdaMargin },
      { label: 'Net profit margin', value: profitability.profitMargin },
    ].map((row) => ({
      ...row,
      fill:
        row.value === null
          ? 0
          : Math.min(100, Math.max(0, (row.value / RATIO_FULL_SCALE) * 100)),
    }));
  });

  /** Returns on equity/assets, read as plain figures rather than bars — see marginBars. */
  protected readonly returnFigures = computed<Figure[]>(() => {
    const profitability = this.data()?.profitability;
    if (!profitability) return [];
    return [
      { label: 'Return on equity', value: this.percent(profitability.returnOnEquity) },
      { label: 'Return on assets', value: this.percent(profitability.returnOnAssets) },
    ];
  });

  protected readonly growthBars = computed<GrowthBar[]>(() => {
    const data = this.data();
    if (!data) return [];
    const { revenueGrowth, earningsGrowth, earningsQuarterlyGrowth } = data.growth;
    return [
      { label: 'Revenue growth', value: revenueGrowth },
      { label: 'Earnings growth', value: earningsGrowth },
      { label: 'Quarterly earnings', value: earningsQuarterlyGrowth },
    ].map((row) => ({
      label: row.label,
      display: this.signedPercent(row.value),
      tone: this.tone(row.value),
      fill:
        row.value === null
          ? 0
          : Math.min(100, (Math.abs(row.value) / GROWTH_BAR_CEILING) * 100),
    }));
  });

  protected readonly healthFigures = computed<Figure[]>(() => {
    const data = this.data();
    if (!data) return [];
    const { health } = data;
    const currentQuick =
      health.currentRatio === null && health.quickRatio === null
        ? '—'
        : `${this.ratio(health.currentRatio)} / ${this.ratio(health.quickRatio)}`;
    return [
      { label: 'Revenue (ttm)', value: this.money(health.totalRevenue) },
      { label: 'EBITDA', value: this.money(health.ebitda) },
      { label: 'Net income', value: this.money(health.netIncome) },
      { label: 'Debt / equity', value: this.ratio(health.debtToEquity) },
      { label: 'Shares outstanding', value: this.count(health.sharesOutstanding) },
      { label: 'Current / quick ratio', value: currentQuick },
      { label: 'Operating cash flow', value: this.money(health.operatingCashflow) },
      { label: 'Free cash flow', value: this.money(health.freeCashflow) },
    ];
  });

  /** Cash and debt, drawn as a pair of bars scaled to whichever of the two is larger. */
  protected readonly cashDebt = computed(() => {
    const health = this.data()?.health;
    if (!health || (health.totalCash === null && health.totalDebt === null)) return null;
    const cash = health.totalCash ?? 0;
    const debt = health.totalDebt ?? 0;
    const scale = Math.max(cash, debt, 1);
    return {
      cashLabel: this.money(health.totalCash),
      debtLabel: this.money(health.totalDebt),
      cashFill: (cash / scale) * 100,
      debtFill: (debt / scale) * 100,
    };
  });

  protected readonly tradingFigures = computed<Figure[]>(() => {
    const data = this.data();
    if (!data) return [];
    const { snapshot } = data;
    return [
      { label: '50-day average', value: this.price(snapshot.fiftyDayAverage) },
      { label: '200-day average', value: this.price(snapshot.twoHundredDayAverage) },
      { label: 'Volume', value: this.count(snapshot.volume) },
      { label: 'Average volume', value: this.count(snapshot.averageVolume) },
    ];
  });

  /** The reported years, most recent first — the order a financials table is read in. */
  protected readonly annualRows = computed<FundamentalsAnnualPeriod[]>(() =>
    [...(this.data()?.annual ?? [])].reverse(),
  );

  protected readonly annualYearRange = computed<string | null>(() => {
    const rows = this.data()?.annual ?? [];
    if (rows.length === 0) return null;
    const first = rows[0].asOfDate.slice(0, 4);
    const last = rows[rows.length - 1].asOfDate.slice(0, 4);
    return first === last ? `FY${first}` : `FY${first} – FY${last}`;
  });

  protected readonly annualMetricLabel = computed(
    () => ANNUAL_METRICS.find((m) => m.key === this.annualMetric())?.label ?? '',
  );

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

  /**
   * Compound annual growth rate of the selected metric across the reported
   * years — null whenever there are fewer than two years, or either end is
   * zero/negative, since a CAGR over a loss-making year is not a rate a
   * reader can act on.
   */
  protected readonly annualCagr = computed<number | null>(() => {
    const metric = this.annualMetric();
    const periods = this.data()?.annual ?? [];
    const values = periods.map((p) => p[metric]).filter((v): v is number => v !== null);
    if (values.length < 2) return null;
    const start = values[0];
    const end = values[values.length - 1];
    if (start <= 0 || end <= 0) return null;
    const years = values.length - 1;
    return (end / start) ** (1 / years) - 1;
  });

  // ── charts ──────────────────────────────────────────────────
  // Chart.js draws to a canvas, which understands literal colour strings and
  // not this app's `var(--...)` design tokens — so the palette below is read
  // from the DOM once per theme flip rather than declared as CSS. Reading
  // `theme()` as the first statement is what makes this recompute on toggle:
  // a signal computed only re-runs when a signal it read last time changes.
  protected readonly chartColors = computed<ChartPalette>(() => {
    this.themeService.theme();
    if (!this.isBrowser) return FALLBACK_PALETTE;
    const style = getComputedStyle(this.document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    return {
      acc: read('--acc') || FALLBACK_PALETTE.acc,
      up: read('--up') || FALLBACK_PALETTE.up,
      down: read('--down') || FALLBACK_PALETTE.down,
      tx2: read('--tx-2') || FALLBACK_PALETTE.tx2,
      tx3: read('--tx-3') || FALLBACK_PALETTE.tx3,
      lineSoft: read('--line-soft') || FALLBACK_PALETTE.lineSoft,
    };
  });

  /** A tiny Chart.js plugin that prints each bar's own formatted value above it. */
  private readonly barValuePlugin = {
    id: 'fundBarValueLabels',
    afterDatasetsDraw: (chart: {
      ctx: CanvasRenderingContext2D;
      data: { datasets: { valueLabels?: (string | null)[]; labelColor?: string }[] };
      getDatasetMeta: (i: number) => { data: { x: number; y: number }[] };
    }) => {
      const { ctx } = chart;
      chart.data.datasets.forEach((dataset, i) => {
        const labels = dataset.valueLabels;
        if (!labels) return;
        const meta = chart.getDatasetMeta(i);
        meta.data.forEach((bar, index) => {
          const label = labels[index];
          if (!label) return;
          ctx.save();
          ctx.fillStyle = dataset.labelColor ?? '#888';
          ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, bar.x, bar.y - 6);
          ctx.restore();
        });
      });
    },
  };

  protected readonly barChartPlugins = [this.barValuePlugin];

  /** The selected metric's values, scaled onto one shared axis with a plain suffix. */
  protected readonly revenueChartData = computed(() => {
    const metric = this.annualMetric();
    const money = ANNUAL_METRICS.find((m) => m.key === metric)?.money ?? true;
    const colors = this.chartColors();
    const periods = this.data()?.annual ?? [];
    const labels = periods.map((p) => p.asOfDate.slice(0, 4));
    const raw = periods.map((p) => p[metric]);

    let scaled = raw;
    let axisSuffix = '';
    if (money) {
      const maxAbs = Math.max(0, ...raw.filter((v): v is number => v !== null).map(Math.abs));
      const { divisor, suffix } = this.moneyScaleFor(maxAbs);
      scaled = raw.map((v) => (v === null ? null : v / divisor));
      axisSuffix = suffix;
    }

    return {
      hasData: raw.some((v) => v !== null),
      axisSuffix,
      chartData: {
        labels,
        datasets: [
          {
            data: scaled,
            backgroundColor: colors.acc,
            borderRadius: 4,
            maxBarThickness: 56,
            valueLabels: raw.map((v) => (v === null ? null : money ? this.money(v) : this.price(v))),
            labelColor: colors.tx2,
          },
        ],
      },
    };
  });

  protected readonly revenueChartOptions = computed(() => {
    const colors = this.chartColors();
    return {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 26, right: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.tx2,
          padding: 8,
          displayColors: false,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: colors.tx3, font: { size: 11 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: colors.lineSoft },
          border: { display: false },
          ticks: {
            color: colors.tx3,
            font: { size: 11 },
            callback: (value: number) => value.toFixed(1),
          },
        },
      },
    };
  });

  /** Operating and net margin, per reported year — derived, since only the current period's is stored. */
  protected readonly marginTrendData = computed(() => {
    const periods = this.data()?.annual ?? [];
    const colors = this.chartColors();
    const labels = periods.map((p) => p.asOfDate.slice(0, 4));
    const marginOf = (income: number | null, revenue: number | null): number | null =>
      income === null || revenue === null || revenue === 0 ? null : (income / revenue) * 100;
    const operating = periods.map((p) => marginOf(p.operatingIncome, p.revenue));
    const net = periods.map((p) => marginOf(p.netIncome, p.revenue));

    return {
      hasData: operating.some((v) => v !== null) || net.some((v) => v !== null),
      chartData: {
        labels,
        datasets: [
          {
            label: 'Operating',
            data: operating,
            borderColor: colors.acc,
            backgroundColor: colors.acc,
            pointBackgroundColor: colors.acc,
            pointBorderColor: colors.acc,
            pointRadius: 3,
            borderWidth: 2,
            tension: 0.35,
            spanGaps: true,
          },
          {
            label: 'Net',
            data: net,
            borderColor: colors.up,
            backgroundColor: colors.up,
            pointBackgroundColor: colors.up,
            pointBorderColor: colors.up,
            pointRadius: 3,
            borderWidth: 2,
            tension: 0.35,
            spanGaps: true,
          },
        ],
      },
    };
  });

  protected readonly marginTrendOptions = computed(() => {
    const colors = this.chartColors();
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.tx2,
          padding: 8,
          callbacks: {
            label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) =>
              ctx.parsed.y === null ? '' : `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: colors.tx3, font: { size: 11 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: colors.lineSoft },
          border: { display: false },
          ticks: {
            color: colors.tx3,
            font: { size: 11 },
            callback: (value: number) => `${value}%`,
          },
        },
      },
    };
  });
}
