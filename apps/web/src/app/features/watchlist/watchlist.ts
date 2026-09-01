import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

import type { Instrument } from '@chartanalyzer/shared';
import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import { ChartCaptureService } from '../../shared/live-chart/chart-capture.service';
import { LiveService } from '../live/live.service';

interface WatchlistItem {
  id: string;
  symbol: string;
  instrument_id: string | null;
  enabled_for_daily_analysis: boolean;
  analysis_lookback_days: number;
  scheduled_hour_ist: number | null;
  instruments: { exchange: string; symbol: string; name: string } | null;
}

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/** A recorded Analyze Now run, as stored in watchlist_analysis_runs. */
interface WatchlistRun {
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

/** Every IST hour, offered as the per-row scheduled run time. */
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * Symbols a user wants to keep an eye on. Reads/writes go straight to
 * Supabase under RLS (watchlist rows carry no financial/entitlement value,
 * so unlike analyses/usage this is plain client-side CRUD) — no backend
 * endpoint for add/remove. Instrument search is the one exception: it goes
 * through the API's /api/instruments/search, since that queries the
 * read-only public.instruments table server-side rather than trusting the
 * client to pick a real instrument id.
 */
@Component({
  selector: 'app-watchlist',
  imports: [FormsModule],
  styleUrl: './watchlist.css',
  templateUrl: './watchlist.html',
})
export class Watchlist implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly http = inject(HttpClient);
  private readonly live = inject(LiveService);
  private readonly chartCapture = inject(ChartCaptureService);

  protected readonly items = signal<WatchlistItem[]>([]);
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
  /** Pending "you already analysed this" confirmation, keyed by item id. */
  protected readonly duplicateWarning = signal<
    Record<string, { lastAnalysisAt: string; lookbackDays: number }>
  >({});
  /** Keyed by watchlist item id, so each row's message is independent. */
  protected readonly analyzeResult = signal<Record<string, string>>({});

  /** How far back a settled run is still worth surfacing on load. */
  private static readonly RESUME_WINDOW_MS = 60 * 60 * 1000;

  protected readonly lookbackOptions = LOOKBACK_OPTIONS;
  protected readonly hourOptions = HOUR_OPTIONS;
  protected readonly minLookbackDays = MIN_LOOKBACK_DAYS;
  protected readonly maxLookbackDays = MAX_LOOKBACK_DAYS;

  /** Item ids whose window is being typed in rather than picked from the list. */
  protected readonly customLookback = signal<Record<string, boolean>>({});

  /** The in-flight run for a row, if any — drives its spinner/disabled state. */
  protected runIdFor(itemId: string): string | undefined {
    return this.activeRuns()[itemId];
  }

  /** True from the moment Analyze Now is pressed until its run settles. */
  protected isBusy(itemId: string): boolean {
    return this.preparing()[itemId] === true || this.activeRuns()[itemId] !== undefined;
  }

  protected readonly queryInput = signal('');
  protected readonly results = signal<Instrument[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly selected = signal<Instrument | null>(null);

  private readonly querySubject = new Subject<string>();

  ngOnInit(): void {
    void this.load();
    void this.resumeRuns();

    this.querySubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((q) => this.search(q)),
      )
      .subscribe((instruments) => {
        this.results.set(instruments);
        this.searching.set(false);
        this.searched.set(true);
      });
  }

  protected onQueryChange(value: string): void {
    this.queryInput.set(value);
    this.selected.set(null);
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      this.results.set([]);
      this.searching.set(false);
      this.searched.set(false);
      return;
    }
    this.searching.set(true);
    this.querySubject.next(trimmed);
  }

  private async search(query: string): Promise<Instrument[]> {
    const token = await this.auth.getAccessToken();
    if (!token) return [];
    try {
      const response = await firstValueFrom(
        this.http.get<{ instruments: Instrument[] }>('/api/instruments/search', {
          params: { q: query },
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return response.instruments;
    } catch {
      return [];
    }
  }

  protected selectInstrument(instrument: Instrument): void {
    this.selected.set(instrument);
    this.queryInput.set(`${instrument.symbol} — ${instrument.name}`);
    this.results.set([]);
    this.searched.set(false);
  }

  protected async load(): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;
    this.loading.set(true);
    const { data, error } = await client
      .from('watchlist_items')
      .select(
        'id, symbol, instrument_id, enabled_for_daily_analysis, analysis_lookback_days, ' +
          'scheduled_hour_ist, instruments(exchange, symbol, name)',
      )
      .order('created_at', { ascending: false });
    if (error) {
      this.error.set('Could not load your watchlist.');
    } else {
      this.items.set((data ?? []) as unknown as WatchlistItem[]);
    }
    this.loading.set(false);
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
    this.queryInput.set('');
    this.selected.set(null);
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
  protected async toggleDailyAnalysis(item: WatchlistItem): Promise<void> {
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
  protected async setLookbackDays(item: WatchlistItem, value: string): Promise<void> {
    if (value === 'custom') {
      this.customLookback.update((custom) => ({ ...custom, [item.id]: true }));
      return;
    }
    const days = Number(value);
    if (!Number.isFinite(days) || days === item.analysis_lookback_days) return;
    await this.patchSettings(item, { analysis_lookback_days: days });
  }

  /** A typed-in window, committed on blur/Enter once it is in range. */
  protected async setCustomLookbackDays(item: WatchlistItem, value: string): Promise<void> {
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
  protected isCustomLookback(item: WatchlistItem): boolean {
    return (
      this.customLookback()[item.id] === true ||
      !LOOKBACK_OPTIONS.some((option) => option.days === item.analysis_lookback_days)
    );
  }

  /** Empty string = follow the deployment default hour (stored as null). */
  protected async setScheduledHour(item: WatchlistItem, value: string): Promise<void> {
    const hour = value === '' ? null : Number(value);
    if (hour === item.scheduled_hour_ist) return;
    await this.patchSettings(item, { scheduled_hour_ist: hour });
  }

  /**
   * Optimistic write of the client-writable settings columns, rolling the row
   * back to its previous values if Supabase rejects it — same shape as
   * toggleDailyAnalysis above.
   */
  private async patchSettings(
    item: WatchlistItem,
    patch: Partial<Pick<WatchlistItem, 'analysis_lookback_days' | 'scheduled_hour_ist'>>,
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

  /** "08:00 IST" for the schedule column. */
  protected formatHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00 IST`;
  }

  /**
   * Runs the same fetch/chart/AI pipeline as the scheduled daily briefing,
   * for this one symbol, right now — consumes one unit of the same
   * 30/month Daily Briefing quota. Independent of the toggle above and of
   * the once-a-day scheduled email: this never touches daily_briefing_log
   * and sends no email, it just produces one analysis immediately.
   *
   * `force` re-runs a chart the user has already analysed recently, after
   * they have confirmed the duplicate warning below.
   *
   * The chart itself is drawn here, in the browser, and posted with the
   * request — the same thing the live chart view does — so the model reads
   * the chart this app renders rather than a separate server-side picture.
   */
  protected async analyzeNow(item: WatchlistItem, force = false): Promise<void> {
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
        this.http.post<{ runId: string }>(`/api/watchlist/${item.id}/analyze-now`, form, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      this.activeRuns.update((runs) => ({ ...runs, [item.id]: accepted.runId }));
      await this.pollRun(item.id, accepted.runId);
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
          },
        }));
        return;
      }

      let message = 'Analysis failed. Please try again.';
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
  private async captureChart(item: WatchlistItem): Promise<Blob | null> {
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

  private static readonly POLL_INTERVAL_MS = 3000;
  private static readonly POLL_MAX_ATTEMPTS = 40; // ~2 min

  /**
   * Picks up runs that are already recorded server-side rather than assuming
   * this tab started (and is still watching) every run: a reload, a second
   * device, or a tab closed mid-run all leave a row here. In-flight runs
   * resume polling; runs that settled while the user was away still show
   * their outcome, so a refresh never loses a result the user paid a quota
   * unit for.
   */
  private async resumeRuns(): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;

    const since = new Date(Date.now() - Watchlist.RESUME_WINDOW_MS).toISOString();
    const { data, error } = await client
      .from('watchlist_analysis_runs')
      .select('id, watchlist_item_id, status, updated_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error || !data) return;

    const seen = new Set<string>();
    for (const run of data as WatchlistRun[]) {
      // Ordered newest-first, so the first row for an item is its latest run.
      if (seen.has(run.watchlist_item_id)) continue;
      seen.add(run.watchlist_item_id);

      const settled = run.status;
      if (settled === 'complete' || settled === 'failed') {
        this.analyzeResult.update((results) => ({
          ...results,
          [run.watchlist_item_id]: Watchlist.settledMessage(settled),
        }));
        continue;
      }

      this.activeRuns.update((runs) => ({ ...runs, [run.watchlist_item_id]: run.id }));
      void this.pollRun(run.watchlist_item_id, run.id);
    }
  }

  private static settledMessage(status: 'complete' | 'failed'): string {
    return status === 'complete'
      ? 'Analysis complete — check your history.'
      : 'Analysis failed. Please try again.';
  }

  /**
   * Watches one run row until it settles. The run row exists from the moment
   * the API accepts the request, so unlike polling `analyses` for a row that
   * may never appear, a failure is an explicit 'failed' status rather than a
   * timeout.
   */
  private async pollRun(itemId: string, runId: string): Promise<void> {
    const client = this.supabase.client;
    if (!client) {
      this.clearRun(itemId);
      return;
    }

    for (let attempt = 0; attempt < Watchlist.POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Watchlist.POLL_INTERVAL_MS));

      const { data, error } = await client
        .from('watchlist_analysis_runs')
        .select('status')
        .eq('id', runId)
        .maybeSingle<{ status: WatchlistRun['status'] }>();

      if (error) continue;

      const settled = data?.status;
      if (settled === 'complete' || settled === 'failed') {
        this.analyzeResult.update((results) => ({
          ...results,
          [itemId]: Watchlist.settledMessage(settled),
        }));
        this.clearRun(itemId);
        return;
      }
    }

    // Only this tab stopped watching; the run itself is still recorded and
    // will be picked up again by resumeRuns on the next load.
    this.analyzeResult.update((results) => ({
      ...results,
      [itemId]: 'Still processing — reopen this page in a bit to see the result.',
    }));
    this.clearRun(itemId);
  }

  private clearRun(itemId: string): void {
    this.activeRuns.update((runs) => {
      const rest = { ...runs };
      delete rest[itemId];
      return rest;
    });
  }

  protected async remove(id: string): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;
    const { error } = await client.from('watchlist_items').delete().eq('id', id);
    if (error) {
      this.error.set('Could not remove symbol.');
      return;
    }
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  /** Canonical symbol/name when resolved, else the legacy free-text symbol. */
  protected displaySymbol(item: WatchlistItem): string {
    return item.instruments?.symbol ?? item.symbol;
  }

  protected displayName(item: WatchlistItem): string | null {
    return item.instruments?.name ?? null;
  }
}
