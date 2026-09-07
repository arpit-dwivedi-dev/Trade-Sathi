import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePicker } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { Select } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import { type Instrument } from '@chartanalyzer/shared';
import { AppIcon } from '../../shared/icons/app-icon';
import { AuthService } from '../../core/auth.service';
import { startRowWatch, type RowWatch } from '../../core/row-watch';
import { SupabaseClientService } from '../../core/supabase-client';
import { ChartCaptureService } from '../../shared/live-chart/chart-capture.service';
import type { SymbolSelection } from '../../shared/symbol-search/symbol-search';
import { BillingService } from '../billing/billing.service';
import { LiveService } from '../../core/live.service';

interface DailyBriefingItem {
  id: string;
  symbol: string;
  instrument_id: string | null;
  enabled_for_daily_analysis: boolean;
  analysis_lookback_days: number;
  scheduled_hour_ist: number | null;
  scheduled_minute_ist: number | null;
  instruments: { exchange: string; symbol: string; name: string } | null;
}

/** A recorded Analyze Now run, as stored in watchlist_analysis_runs. */
/**
 * Which of the two row actions a run came from.
 *
 * They spend the same Daily Briefing entitlement and run the same pipeline —
 * the only difference is that 'brief' emails the result with its PDF attached.
 */
type RunMode = 'analyze' | 'brief';

interface DailyBriefingRun {
  id: string;
  watchlist_item_id: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  updated_at: string;
}


/**
 * Chart windows offered per row, in days. Must stay inside the 1-365 CHECK on
 * watchlist_items.analysis_lookback_days — the DB is the real guard, this
 * list is just the shortlist. Anything else is reachable through "Custom".
 * Short windows are drawn from intraday candles server-side, so a 1-day chart
 * is a real chart, not a single candle.
 */
const LOOKBACK_OPTIONS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
] as const;

const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;


/**
 * Symbols a user wants to keep an eye on. Reads/writes go straight to
 * Supabase under RLS (watchlist rows carry no financial/entitlement value,
 * so unlike analyses/usage this is plain client-side CRUD) — no backend
 * endpoint for add/remove. Instrument search is the one exception: it goes
 * through the API's /api/instruments/search, since that queries the
 * read-only public.instruments table server-side rather than trusting the
 * client to pick a real instrument id. That search itself lives in the
 * shell's top bar for every tab that needs one — this screen receives the
 * chosen instrument through `selection` and only stages it for adding.
 */
@Component({
  selector: 'app-daily-briefing',
  imports: [
    FormsModule,
    RouterLink,
    AppIcon,
    ButtonModule,
    CardModule,
    DatePicker,
    InputTextModule,
    ProgressSpinnerModule,
    Select,
    TableModule,
    ToggleSwitchModule,
  ],
  styleUrl: './daily-briefing.css',
  templateUrl: './daily-briefing.html',
})
export class DailyBriefing implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly http = inject(HttpClient);
  private readonly live = inject(LiveService);
  private readonly chartCapture = inject(ChartCaptureService);
  protected readonly billing = inject(BillingService);

  protected readonly columns = ['symbol', 'window', 'runAt', 'dailyBriefing', 'actions'];

  protected readonly items = signal<DailyBriefingItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /**
   * Run id per watchlist item currently being watched. A map rather than a
   * single id: a run started on another device (or before a reload) is
   * resumed here alongside anything this tab started.
   */
  protected readonly activeRuns = signal<Record<string, string>>({});
  /**
   * Items whose chart is being fetched and drawn, before the request is even
   * sent. Separate from activeRuns because there is no run id yet, and the
   * row still has to look busy — a capture takes a second or two.
   */
  protected readonly preparing = signal<Record<string, boolean>>({});
  /**
   * Item awaiting a remove confirmation, or null.
   *
   * Removing was a single unguarded click on a small icon next to "Analyze
   * now", and it cascades: the item's recorded runs go with it and there is no
   * undo. Confirmed inline, matching the duplicate-analysis warning below,
   * rather than through a browser confirm() dialog.
   */
  protected readonly pendingRemoval = signal<string | null>(null);

  /**
   * Pending "you already analysed this" confirmation, keyed by item id.
   *
   * `mode` is carried so the confirm button re-runs what the user actually
   * pressed: without it, confirming a duplicate from Brief Now silently ran a
   * plain Analyze Now and no email was ever sent.
   */
  protected readonly duplicateWarning = signal<
    Record<string, { lastAnalysisAt: string; lookbackDays: number; mode: RunMode }>
  >({});

  /**
   * Which action started each in-flight run, so the settled message can say
   * whether an email went out. Not persisted anywhere: a run resumed after a
   * reload (see resumeRuns) reports the neutral wording, because the run row
   * does not record which button produced it.
   */
  private readonly runModes = signal<Record<string, RunMode>>({});
  /** Keyed by watchlist item id, so each row's message is independent. */
  protected readonly analyzeResult = signal<Record<string, string>>({});

  /**
   * matRowDef's `when` predicate for a row's note (remove confirm / duplicate
   * warning / result message — mutually exclusive, see the template).
   */
  protected readonly hasRowNote = (_index: number, item: DailyBriefingItem): boolean =>
    this.pendingRemoval() === item.id ||
    this.duplicateWarning()[item.id] !== undefined ||
    this.analyzeResult()[item.id] !== undefined;

  /**
   * CdkTable only re-evaluates matRowDef's `when` predicates when the bound
   * [dataSource] reference itself changes (see history-list.ts's tableRows
   * for the full explanation) — none of pendingRemoval/duplicateWarning/
   * analyzeResult touch `items`, so this is what makes a note row actually
   * appear/disappear rather than just existing but never rendering.
   */
  protected readonly tableRows = computed(() => {
    this.pendingRemoval();
    this.duplicateWarning();
    this.analyzeResult();
    return [...this.items()];
  });

  /** How far back a settled run is still worth surfacing on load. */
  private static readonly RESUME_WINDOW_MS = 60 * 60 * 1000;

  protected readonly lookbackOptions = LOOKBACK_OPTIONS;

  /** p-select needs a flat {label, value} array — LOOKBACK_OPTIONS plus the 'Custom…' escape hatch. */
  protected readonly lookbackSelectOptions = [
    ...LOOKBACK_OPTIONS.map((option) => ({ label: option.label, value: option.days })),
    { label: 'Custom…', value: 'custom' },
  ];
  protected readonly minLookbackDays = MIN_LOOKBACK_DAYS;
  protected readonly maxLookbackDays = MAX_LOOKBACK_DAYS;

  /** Item ids whose window is being typed in rather than picked from the list. */
  protected readonly customLookback = signal<Record<string, boolean>>({});

  /** The in-flight run for a row, if any — drives its spinner/disabled state. */
  protected runIdFor(itemId: string): string | undefined {
    return this.activeRuns()[itemId];
  }

  /**
   * (hour, minute) slots of this profile's currently-'processing'
   * daily_briefing_log rows — i.e. the SCHEDULED job is mid-run right now.
   * Kept live via Realtime rather than polled (see the subscription in
   * ngOnInit): a scheduled run is typically seconds long, and a poll interval
   * would either miss it entirely between ticks or add constant background
   * traffic for something that changes rarely.
   */
  private readonly processingSlots = signal<{ hour: number; minute: number }[]>([]);

  /**
   * Items the scheduled job is processing right now, derived by matching each
   * item's own (scheduled_hour_ist, scheduled_minute_ist) against
   * processingSlots. Only items with an EXPLICIT Run-at hour are matched —
   * one left on "Default" resolves its hour from a server-side env var
   * (DAILY_BRIEFING_RUN_HOUR_IST) that this client has no way to read, so it
   * is deliberately excluded rather than guessed at.
   */
  protected readonly scheduledBusyItemIds = computed<ReadonlySet<string>>(() => {
    const slots = this.processingSlots();
    if (slots.length === 0) return new Set();
    const busy = new Set<string>();
    for (const item of this.items()) {
      if (!item.enabled_for_daily_analysis || item.scheduled_hour_ist === null) continue;
      const minute = item.scheduled_minute_ist ?? 0;
      if (slots.some((slot) => slot.hour === item.scheduled_hour_ist && slot.minute === minute)) {
        busy.add(item.id);
      }
    }
    return busy;
  });

  private briefingLogChannel: RealtimeChannel | null = null;

  /**
   * Live run watches by run id, so ngOnDestroy can close their channels. A
   * leaked channel is not just a timer: it holds a Realtime subscription open
   * for a component that is gone.
   */
  private readonly runWatches = new Map<string, RowWatch>();

  /**
   * True from the moment Analyze Now or Brief Now is pressed until its run
   * settles, OR while the scheduled job is processing this item (see
   * scheduledBusyItemIds above) — the two paths share the same visual
   * "something is happening to this row right now" state even though only
   * the first ever sets preparing/activeRuns.
   */
  protected isBusy(itemId: string): boolean {
    return (
      this.preparing()[itemId] === true ||
      this.activeRuns()[itemId] !== undefined ||
      this.scheduledBusyItemIds().has(itemId)
    );
  }

  /**
   * The instrument picked in the shell's top-bar search, staged for adding.
   * Staged rather than added outright: picking a symbol is a search result,
   * not consent to start analysing it daily.
   */
  protected readonly selected = signal<Instrument | null>(null);

  /**
   * Set by AppPage from the top-bar search while this tab is open.
   */
  readonly selection = input<SymbolSelection | null>(null);
  /** Asks the shell to empty the top-bar search once an add has landed. */
  readonly addCompleted = output<void>();

  /**
   * The Daily Briefing tab is unmounted whenever the user looks at another tab.
   * A run watch outlives that on its own — it would keep querying for up to
   * two minutes after destruction and keep writing to signals nobody is
   * rendering — so every check reads this and stops. ngOnDestroy also closes
   * the watches outright; this covers a check already in flight.
   */
  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const watch of this.runWatches.values()) watch.stop();
    this.runWatches.clear();
    if (this.briefingLogChannel) {
      void this.supabase.client?.removeChannel(this.briefingLogChannel);
      this.briefingLogChannel = null;
    }
  }

  constructor() {
    // Stages whatever the shell's search hands down, including the same
    // symbol picked twice — see SymbolSelection's requestId.
    effect(() => {
      const selection = this.selection();
      if (!selection) return;
      this.selected.set(selection.instrument);
      this.error.set(null);
    });
  }

  ngOnInit(): void {
    void this.load();
    void this.resumeRuns();
    void this.billing.ensurePlanSummary();
    void this.loadProcessingSlots();
    this.watchBriefingLog();
  }

  /** Drops a staged instrument without adding it. */
  protected clearSelection(): void {
    this.selected.set(null);
    this.addCompleted.emit();
  }

  protected async load(): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;
    this.loading.set(true);
    try {
      const { data, error } = await client
        .from('watchlist_items')
        .select(
          'id, symbol, instrument_id, enabled_for_daily_analysis, analysis_lookback_days, ' +
            'scheduled_hour_ist, scheduled_minute_ist, instruments(exchange, symbol, name)',
        )
        .order('created_at', { ascending: false });
      if (error) {
        this.error.set('Could not load your watchlist.');
      } else {
        this.items.set((data ?? []) as unknown as DailyBriefingItem[]);
      }
    } catch {
      this.error.set('Could not load your watchlist.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async add(): Promise<void> {
    const client = this.supabase.client;
    const profileId = this.auth.user()?.id;
    const instrument = this.selected();
    if (!client || !profileId || !instrument) return;

    this.saving.set(true);
    this.error.set(null);
    const { error } = await client.from('watchlist_items').insert({
      profile_id: profileId,
      symbol: instrument.symbol,
      instrument_id: instrument.id,
      analysis_lookback_days: 1,
      scheduled_hour_ist: 7,
      scheduled_minute_ist: 0,
    });
    this.saving.set(false);

    if (error) {
      this.error.set(
        error.code === '23505'
          ? `${instrument.symbol} is already on your watchlist.`
          : 'Could not add instrument.',
      );
      return;
    }
    this.selected.set(null);
    this.addCompleted.emit();
    await this.load();
  }

  /**
   * Clients may write exactly three columns — enabled_for_daily_analysis (see
   * the column-scoped grant in
   * 20260831160000_watchlist_daily_analysis_flag.sql) plus
   * analysis_lookback_days and scheduled_hour_ist
   * (20260831170000_watchlist_analysis_settings.sql). Everything else about a
   * watch entry is immutable once added.
   */
  protected async toggleDailyAnalysis(item: DailyBriefingItem): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;
    const next = !item.enabled_for_daily_analysis;
    this.items.update((items) =>
      items.map((i) => (i.id === item.id ? { ...i, enabled_for_daily_analysis: next } : i)),
    );
    const { error } = await client
      .from('watchlist_items')
      .update({ enabled_for_daily_analysis: next })
      .eq('id', item.id);
    if (error) {
      this.items.update((items) =>
        items.map((i) => (i.id === item.id ? { ...i, enabled_for_daily_analysis: !next } : i)),
      );
      this.error.set('Could not update daily analysis setting.');
    }
  }

  /**
   * Chart window, in calendar days, this row's analyses are generated from.
   * The sentinel 'custom' swaps the row's preset list for a free number input
   * instead of writing anything.
   */
  protected async setLookbackDays(item: DailyBriefingItem, value: string): Promise<void> {
    if (value === 'custom') {
      this.customLookback.update((custom) => ({ ...custom, [item.id]: true }));
      return;
    }
    const days = Number(value);
    if (!Number.isFinite(days) || days === item.analysis_lookback_days) return;
    await this.patchSettings(item, { analysis_lookback_days: days });
  }

  /** A typed-in window, committed on blur/Enter once it is in range. */
  protected async setCustomLookbackDays(item: DailyBriefingItem, value: string): Promise<void> {
    const days = Math.round(Number(value));
    if (
      !Number.isFinite(days) ||
      days < MIN_LOOKBACK_DAYS ||
      days > MAX_LOOKBACK_DAYS ||
      days === item.analysis_lookback_days
    ) {
      return;
    }
    await this.patchSettings(item, { analysis_lookback_days: days });
  }

  /**
   * A row shows the number input either because the user asked for it or
   * because its stored window simply is not one of the presets (set earlier,
   * or on another device).
   */
  protected isCustomLookback(item: DailyBriefingItem): boolean {
    return (
      this.customLookback()[item.id] === true ||
      !LOOKBACK_OPTIONS.some((option) => option.days === item.analysis_lookback_days)
    );
  }

  /** The hour select's bound value: the sentinel 'default' or 0-23. */
  protected scheduledHourValue(item: DailyBriefingItem): 'default' | number {
    return item.scheduled_hour_ist ?? 'default';
  }

  /**
   * PrimeNG's timeOnly p-datepicker binds to a Date, not raw hour/minute
   * numbers — the day/month/year are irrelevant and ignored, only
   * getHours()/getMinutes() are read back in setScheduledTime below.
   */
  private readonly scheduledTimeCache = new Map<string, { key: string; value: Date }>();

  /**
   * Passed as the picker's `[defaultDate]` so a 'Default' row (ngModel null)
   * highlights midnight on first open instead of PrimeNG's own fallback of
   * `new Date()` — which showed whichever hour happened to be the real
   * wall-clock time when the row's picker initialized, looking like a
   * pre-selected time rather than "unset".
   */
  protected readonly midnightDefaultDate = new Date(0, 0, 0, 0, 0);

  /**
   * Memoized by item id + hour/minute: this is called from the template on
   * every change-detection pass, and returning a fresh Date each time made
   * PrimeNG's p-datepicker see a "changed" input on every tick, churning its
   * overlay/writeValue logic per row and stalling the tab with enough rows.
   */
  protected scheduledTimeValue(item: DailyBriefingItem): Date | null {
    if (item.scheduled_hour_ist === null) {
      this.scheduledTimeCache.delete(item.id);
      return null;
    }
    const key = `${item.scheduled_hour_ist}:${item.scheduled_minute_ist ?? 0}`;
    const cached = this.scheduledTimeCache.get(item.id);
    if (cached && cached.key === key) return cached.value;

    const date = new Date();
    date.setHours(item.scheduled_hour_ist, item.scheduled_minute_ist ?? 0, 0, 0);
    this.scheduledTimeCache.set(item.id, { key, value: date });
    return date;
  }

  protected async setScheduledTime(item: DailyBriefingItem, value: Date): Promise<void> {
    const hour = value.getHours();
    const minute = value.getMinutes();
    if (hour === item.scheduled_hour_ist && minute === item.scheduled_minute_ist) return;
    await this.patchSettings(item, { scheduled_hour_ist: hour, scheduled_minute_ist: minute });
  }

  /** Clears the schedule back to the deployment default (both columns null). */
  protected async clearScheduledTime(item: DailyBriefingItem): Promise<void> {
    if (item.scheduled_hour_ist === null) return;
    await this.patchSettings(item, { scheduled_hour_ist: null, scheduled_minute_ist: null });
  }

  /**
   * Optimistic write of the client-writable settings columns, rolling the row
   * back to its previous values if Supabase rejects it — same shape as
   * toggleDailyAnalysis above.
   */
  private async patchSettings(
    item: DailyBriefingItem,
    patch: Partial<
      Pick<DailyBriefingItem, 'analysis_lookback_days' | 'scheduled_hour_ist' | 'scheduled_minute_ist'>
    >,
  ): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;
    this.error.set(null);
    this.items.update((items) => items.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    const { error } = await client.from('watchlist_items').update(patch).eq('id', item.id);
    if (error) {
      this.items.update((items) => items.map((i) => (i.id === item.id ? item : i)));
      this.error.set('Could not update analysis settings.');
    }
  }

  /**
   * Runs the same fetch/chart/AI pipeline as the scheduled daily briefing,
   * for this one symbol, right now — consumes one unit of the same
   * 30/month Daily Briefing quota (then a top-up credit, once that is spent).
   * Independent of the toggle above and of the once-a-day scheduled email:
   * neither mode touches daily_briefing_log.
   *
   * `mode` picks which of the two row actions this is. 'analyze' just produces
   * the analysis; 'brief' also emails it, with the PDF attached. They are one
   * method rather than two because everything else — the entitlement, the
   * chart capture, the duplicate warning, the 202-then-watch contract, the
   * error mapping — is identical, and the endpoint is the only fork.
   *
   * `force` re-runs a chart the user has already analysed recently, after
   * they have confirmed the duplicate warning below.
   *
   * The chart itself is drawn here, in the browser, and posted with the
   * request — the same thing the live chart view does — so the model reads
   * the chart this app renders rather than a separate server-side picture.
   */
  protected async analyzeNow(
    item: DailyBriefingItem,
    force = false,
    mode: RunMode = 'analyze',
  ): Promise<void> {
    if (this.isBusy(item.id)) return;
    this.duplicateWarning.update((warnings) => {
      const rest = { ...warnings };
      delete rest[item.id];
      return rest;
    });
    this.analyzeResult.update((results) => {
      const rest = { ...results };
      delete rest[item.id];
      return rest;
    });

    const token = await this.auth.getAccessToken();
    if (!token) return;

    this.preparing.update((rows) => ({ ...rows, [item.id]: true }));
    let chart: Blob | null;
    try {
      chart = await this.captureChart(item);
    } finally {
      this.preparing.update((rows) => {
        const rest = { ...rows };
        delete rest[item.id];
        return rest;
      });
    }

    // Sent as multipart, and deliberately without an explicit Content-Type:
    // the browser has to set it itself so the multipart boundary matches.
    const form = new FormData();
    form.append('force', String(force));
    if (chart) form.append('image', chart, 'chart.png');

    try {
      // The API kicks off the fetch/chart/AI pipeline in the background and
      // responds as soon as its fast checks pass (202) — the pipeline itself
      // takes 20-30+ seconds, too long for some proxies/tunnels to hold a
      // request open. It records the run in watchlist_analysis_runs (readable
      // under RLS) and we poll that row rather than waiting on this call.
      const accepted = await firstValueFrom(
        this.http.post<{ runId: string }>(
          `/api/daily-briefing/${item.id}/${mode === 'brief' ? 'brief-now' : 'analyze-now'}`,
          form,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      this.runModes.update((modes) => ({ ...modes, [item.id]: mode }));
      this.activeRuns.update((runs) => ({ ...runs, [item.id]: accepted.runId }));
      this.watchRun(item.id, accepted.runId);
    } catch (cause) {
      if (cause instanceof HttpErrorResponse && cause.status === 409) {
        // Not a failure: the same symbol over the same window was analysed in
        // the last 24h. Ask rather than silently spend another quota unit.
        const body = cause.error as { lastAnalysisAt?: string; lookbackDays?: number };
        this.duplicateWarning.update((warnings) => ({
          ...warnings,
          [item.id]: {
            lastAnalysisAt: body?.lastAnalysisAt ?? '',
            lookbackDays: body?.lookbackDays ?? item.analysis_lookback_days,
            mode,
          },
        }));
        return;
      }

      let message = mode === 'brief' ? 'Briefing failed. Please try again.' : 'Analysis failed. Please try again.';
      if (cause instanceof HttpErrorResponse) {
        const body: unknown = cause.error;
        if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
          message = (body as { error: string }).error;
        }
      }
      this.analyzeResult.update((results) => ({ ...results, [item.id]: message }));
    }
  }

  /**
   * Fetches this row's window and renders it with the same chart component
   * the live view uses, off-screen, returning the PNG to post.
   *
   * Null on any failure — a legacy row with no resolved instrument, market
   * data that will not load, a browser that refuses the canvas export. The
   * API then renders the chart itself, exactly as the scheduled daily
   * briefing does, so the analysis still happens.
   */
  private async captureChart(item: DailyBriefingItem): Promise<Blob | null> {
    const instrumentId = item.instrument_id;
    if (!instrumentId) return null;

    const result = await this.live.fetchCandles(instrumentId, item.analysis_lookback_days);
    if (!result.ok) return null;

    return this.chartCapture.capture(result.window.candles, {
      symbol: result.window.instrument.symbol,
      name: result.window.instrument.name,
      exchange: result.window.instrument.exchange,
      timeframeLabel: result.window.timeframeLabel,
    });
  }

  protected dismissDuplicate(itemId: string): void {
    this.duplicateWarning.update((warnings) => {
      const rest = { ...warnings };
      delete rest[itemId];
      return rest;
    });
  }

  /** "31 Aug, 14:05" — enough for the user to recognise their own earlier run. */
  protected formatTimestamp(iso: string): string {
    if (!iso) return 'recently';
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Reads this profile's currently-'processing' daily_briefing_log rows and
   * updates processingSlots — the seed read for scheduledBusyItemIds, and
   * also what re-runs on every Realtime event from watchBriefingLog below (a
   * status change is exactly what a client-side filter on the row's own
   * columns cannot see, so this re-fetches rather than trying to patch the
   * signal from the event payload).
   */
  private async loadProcessingSlots(): Promise<void> {
    const client = this.supabase.client;
    if (!client || this.destroyed) return;

    const { data, error } = await client
      .from('daily_briefing_log')
      .select('run_hour_ist, run_minute_ist')
      .eq('status', 'processing');
    if (error || this.destroyed) return;

    const rows = (data ?? []) as { run_hour_ist: number; run_minute_ist: number }[];
    this.processingSlots.set(rows.map((row) => ({ hour: row.run_hour_ist, minute: row.run_minute_ist })));
  }

  /**
   * Subscribes to this profile's own daily_briefing_log rows so a scheduled
   * run's start/finish is reflected within moments rather than on a fixed
   * interval that could miss a run shorter than itself — the same mechanism
   * watchRun below now uses for an Analyze Now run. RLS scopes the
   * subscription server-side, same as the read
   * above, but the filter is still passed so this socket is not asked to
   * carry rows for anyone else's profile in the first place.
   */
  private watchBriefingLog(): void {
    const client = this.supabase.client;
    const profileId = this.auth.user()?.id;
    if (!client || !profileId) return;

    this.briefingLogChannel = client
      .channel(`watchlist-briefing-log-${profileId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'daily_briefing_log',
          filter: `profile_id=eq.${profileId}`,
        },
        () => void this.loadProcessingSlots(),
      )
      .subscribe();
  }

  /**
   * How long a single run is watched before this tab stops caring. Unchanged
   * from the two minutes the old 3s x 40 poll loop allowed: the run itself is
   * recorded server-side either way, so this is only how long a spinner is
   * held, not how long the pipeline is given.
   */
  private static readonly RUN_WATCH_TIMEOUT_MS = 120_000;

  /**
   * Picks up runs that are already recorded server-side rather than assuming
   * this tab started (and is still watching) every run: a reload, a second
   * device, or a tab closed mid-run all leave a row here. In-flight runs
   * resume watching; runs that settled while the user was away still show
   * their outcome, so a refresh never loses a result the user paid a quota
   * unit for.
   */
  private async resumeRuns(): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;

    const since = new Date(Date.now() - DailyBriefing.RESUME_WINDOW_MS).toISOString();
    const { data, error } = await client
      .from('watchlist_analysis_runs')
      .select('id, watchlist_item_id, status, updated_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error || !data || this.destroyed) return;

    const seen = new Set<string>();
    for (const run of data as DailyBriefingRun[]) {
      // Ordered newest-first, so the first row for an item is its latest run.
      if (seen.has(run.watchlist_item_id)) continue;
      seen.add(run.watchlist_item_id);

      const settled = run.status;
      if (settled === 'complete' || settled === 'failed') {
        this.analyzeResult.update((results) => ({
          ...results,
          [run.watchlist_item_id]: DailyBriefing.settledMessage(settled),
        }));
        continue;
      }

      this.activeRuns.update((runs) => ({ ...runs, [run.watchlist_item_id]: run.id }));
      this.watchRun(run.watchlist_item_id, run.id);
    }
  }

  /**
   * `mode` defaults to 'analyze' so a run resumed after a reload reports the
   * neutral wording: watchlist_analysis_runs does not record which button
   * started it, and claiming an email was sent when it may not have been is
   * worse than omitting the detail.
   */
  private static settledMessage(status: 'complete' | 'failed', mode: RunMode = 'analyze'): string {
    if (status === 'failed') {
      return mode === 'brief'
        ? 'Briefing failed. Please try again.'
        : 'Analysis failed. Please try again.';
    }
    return mode === 'brief'
      ? 'Briefing sent — check your inbox for the PDF. It is in your history too.'
      : 'Analysis complete — check your history.';
  }

  /**
   * Watches one run row until it settles. The run row exists from the moment
   * the API accepts the request, so unlike watching `analyses` for a row that
   * may never appear, a failure is an explicit 'failed' status rather than a
   * timeout.
   *
   * Driven by Realtime rather than a fixed interval (startRowWatch keeps a
   * slow timer as the fallback for a browser that cannot hold the socket).
   * A run settles exactly twice in its life and takes 20-30s, so a 3-second
   * poll spent ten wide reads per run to learn about a change the database
   * can push, and still reported it up to three seconds late.
   */
  private watchRun(itemId: string, runId: string): void {
    const client = this.supabase.client;
    if (!client) {
      this.clearRun(itemId);
      return;
    }

    const startedAt = Date.now();
    let settled = false;
    let watch: RowWatch | null = null;

    const stop = (): void => {
      settled = true;
      watch?.stop();
      watch = null;
    };

    const check = async (): Promise<void> => {
      if (settled) return;
      // The run itself is recorded server-side and resumeRuns picks it up on
      // the next mount, so abandoning the watch here loses nothing.
      if (this.destroyed) {
        stop();
        return;
      }

      if (Date.now() - startedAt >= DailyBriefing.RUN_WATCH_TIMEOUT_MS) {
        stop();
        // Only this tab stopped watching; the run itself is still recorded and
        // will be picked up again by resumeRuns on the next load.
        this.analyzeResult.update((results) => ({
          ...results,
          [itemId]: 'Still processing — reopen this page in a bit to see the result.',
        }));
        this.clearRun(itemId);
        return;
      }

      const { data, error } = await client
        .from('watchlist_analysis_runs')
        .select('status')
        .eq('id', runId)
        .maybeSingle<{ status: DailyBriefingRun['status'] }>();

      // A read blip is not a failed run: the next event or fallback tick
      // retries, and the timeout above is what eventually gives up.
      if (error || settled) return;

      const status = data?.status;
      if (status === 'complete' || status === 'failed') {
        stop();
        this.analyzeResult.update((results) => ({
          ...results,
          [itemId]: DailyBriefing.settledMessage(status, this.runModes()[itemId]),
        }));
        this.clearRun(itemId);
      }
    };

    watch = startRowWatch(
      client,
      `watchlist-run-${runId}`,
      'watchlist_analysis_runs',
      `id=eq.${runId}`,
      () => void check(),
    );
    this.runWatches.set(runId, watch);
  }

  private clearRun(itemId: string): void {
    const runId = this.activeRuns()[itemId];
    if (runId) {
      this.runWatches.get(runId)?.stop();
      this.runWatches.delete(runId);
    }
    this.activeRuns.update((runs) => {
      const rest = { ...runs };
      delete rest[itemId];
      return rest;
    });
    // Dropped after the settled message has already been built from it, so the
    // record never outlives the run it describes.
    this.runModes.update((modes) => {
      const rest = { ...modes };
      delete rest[itemId];
      return rest;
    });
  }

  /** Asks for confirmation; the second step is confirmRemove below. */
  protected requestRemove(id: string): void {
    // An in-flight run is about to write to this item; let it finish rather
    // than deleting the row out from under it.
    if (this.isBusy(id)) return;
    this.error.set(null);
    this.pendingRemoval.set(id);
  }

  protected cancelRemove(): void {
    this.pendingRemoval.set(null);
  }

  protected async confirmRemove(id: string): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;

    this.pendingRemoval.set(null);
    const { error } = await client.from('watchlist_items').delete().eq('id', id);
    if (error) {
      this.error.set('Could not remove symbol.');
      return;
    }
    this.items.update((items) => items.filter((item) => item.id !== id));
    // Nothing left to report about an item that is gone.
    this.analyzeResult.update((results) => {
      const rest = { ...results };
      delete rest[id];
      return rest;
    });
  }

  /** Canonical symbol/name when resolved, else the legacy free-text symbol. */
  protected displaySymbol(item: DailyBriefingItem): string {
    return item.instruments?.symbol ?? item.symbol;
  }

  protected displayName(item: DailyBriefingItem): string | null {
    return item.instruments?.name ?? null;
  }
}
