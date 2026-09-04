import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';

/** Mirrors the daily_briefing_status enum in 20260831160300_daily_briefing_schema.sql. */
type BriefingLogStatus =
  | 'processing'
  | 'sent'
  | 'sent_partial'
  | 'skipped_no_symbols'
  | 'skipped_no_entitlement'
  | 'skipped_quota_exhausted'
  | 'failed';

interface BriefingLogRow {
  id: string;
  briefing_date: string;
  run_hour_ist: number;
  run_minute_ist: number;
  status: BriefingLogStatus;
  symbols_sent: number;
  symbols_failed: number;
  updated_at: string;
}

interface WatchlistRunRow {
  id: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  lookback_days: number;
  created_at: string;
  instruments: { symbol: string; name: string } | null;
}

interface ErrorLogRow {
  id: string;
  category: string;
  message: string;
  detail: unknown;
  created_at: string;
}

const ROW_LIMIT = 20;

/**
 * The signed-in user's own operational history, grouped by category — the
 * one place a background failure (a scheduled briefing, an Analyze Now run
 * that never produced an analysis) is visible at all. Everything here is a
 * plain client-side read under RLS: daily_briefing_log and
 * watchlist_analysis_runs already existed and were already readable this way;
 * app_error_logs (20260901160000_app_error_logs.sql) is the one new source,
 * added because apps/api's logger previously only ever wrote to stdout.
 *
 * Three independent fetches rather than one combined query: the three tables
 * share no common key to union on (a scheduled slot has no watchlist item,
 * an error may have neither), and each category renders differently, so
 * merging them into one shape would buy nothing.
 */
@Component({
  selector: 'app-logs-page',
  imports: [MatCardModule, MatChipsModule, MatProgressSpinnerModule],
  templateUrl: './logs-page.html',
  styleUrl: './logs-page.css',
})
export class LogsPage implements OnInit, OnDestroy {
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly briefingLog = signal<BriefingLogRow[]>([]);
  protected readonly watchlistRuns = signal<WatchlistRunRow[]>([]);
  protected readonly errorLog = signal<ErrorLogRow[]>([]);

  /** Open subscriptions, one per source table; closed in ngOnDestroy. */
  private channels: RealtimeChannel[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /**
   * Coalescing window for Realtime events. A single briefing run touches all
   * three tables within a second or two, and this page re-reads all three at
   * once, so one reload per event would be three near-identical triples.
   */
  private static readonly RELOAD_DEBOUNCE_MS = 500;

  ngOnInit(): void {
    void this.load();
    this.watchSources();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    const client = this.supabase.client;
    for (const channel of this.channels) void client?.removeChannel(channel);
    this.channels = [];
  }

  /**
   * Keeps the page live rather than a snapshot taken on mount.
   *
   * This is the page a user opens *because* something is running, which is
   * exactly when a mount-time read is most likely to be stale a second later:
   * a run settling, a briefing finishing, an error being written. Each source
   * is subscribed separately because they are separate tables — a channel is
   * per (table, filter) — and any of them changing re-reads all three, since
   * load() is a single cheap triple and the page renders them together.
   *
   * RLS scopes each subscription server-side; the profile filter is still
   * passed so these sockets are not asked to carry anyone else's rows.
   */
  private watchSources(): void {
    const client = this.supabase.client;
    const profileId = this.auth.user()?.id;
    if (!client || !profileId) return;

    for (const table of ['app_error_logs', 'watchlist_analysis_runs', 'daily_briefing_log']) {
      const channel = client
        .channel(`logs-${table}-${profileId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `profile_id=eq.${profileId}` },
          () => this.scheduleReload(),
        )
        .subscribe();
      this.channels.push(channel);
    }
  }

  private scheduleReload(): void {
    if (this.destroyed || this.reloadTimer !== null) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      // Skipped while a read is already in flight; that read is itself newer
      // than the event, and the next event reloads again anyway.
      if (this.destroyed || this.loading()) return;
      void this.load(true);
    }, LogsPage.RELOAD_DEBOUNCE_MS);
  }

  /**
   * Human wording for a category. app_error_logs.category is free text by
   * design (see its migration), so an unknown value falls back to itself
   * rather than being dropped — a new category from the API must never make
   * a row unreadable here.
   */
  protected categoryLabel(category: string): string {
    switch (category) {
      case 'analysis':
        return 'upload';
      case 'live_run':
        return 'live chart';
      case 'fundamentals_analysis':
        return 'fundamentals';
      case 'watchlist_run':
        return 'watchlist';
      case 'briefing':
        return 'daily briefing';
      default:
        return category;
    }
  }

  /**
   * `background` is set by the Realtime path: that read replaces content the
   * user is already looking at, and swapping a populated page for a spinner
   * every time a row changes would be worse than the stale snapshot this
   * whole subscription exists to fix. It also leaves the last error banner
   * alone until it knows better, for the same reason.
   */
  protected async load(background = false): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;

    if (!background) {
      this.loading.set(true);
      this.error.set(null);
    }

    const [briefing, runs, errors] = await Promise.all([
      client
        .from('daily_briefing_log')
        .select('id, briefing_date, run_hour_ist, run_minute_ist, status, symbols_sent, symbols_failed, updated_at')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT)
        .returns<BriefingLogRow[]>(),
      client
        .from('watchlist_analysis_runs')
        .select('id, status, lookback_days, created_at, instruments(symbol, name)')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT)
        .returns<WatchlistRunRow[]>(),
      client
        .from('app_error_logs')
        .select('id, category, message, detail, created_at')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT)
        .returns<ErrorLogRow[]>(),
    ]);

    if (this.destroyed) return;

    if (briefing.error || runs.error || errors.error) {
      // A failed background refresh keeps whatever is on screen: it is still
      // valid, and the next event retries.
      if (!background) this.error.set('Could not load your logs.');
    } else {
      this.error.set(null);
      this.briefingLog.set(briefing.data ?? []);
      this.watchlistRuns.set(runs.data ?? []);
      this.errorLog.set(errors.data ?? []);
    }
    if (!background) this.loading.set(false);
  }

  protected briefingStatusLabel(row: BriefingLogRow): string {
    switch (row.status) {
      case 'processing':
        return 'Running…';
      case 'sent':
        return 'Sent';
      case 'sent_partial':
        return `Sent — ${row.symbols_sent} sent, ${row.symbols_failed} failed`;
      case 'skipped_no_symbols':
        return 'Skipped — no symbols due at this time';
      case 'skipped_no_entitlement':
        return 'Skipped — no active Daily Briefing subscription or credit';
      case 'skipped_quota_exhausted':
        return 'Skipped — Daily Briefing quota exhausted';
      case 'failed':
        return 'Failed';
    }
  }

  protected briefingTimeLabel(row: BriefingLogRow): string {
    const hour = String(row.run_hour_ist).padStart(2, '0');
    const minute = String(row.run_minute_ist).padStart(2, '0');
    return `${hour}:${minute} IST`;
  }

  protected briefingIsFailure(row: BriefingLogRow): boolean {
    return (
      row.status === 'failed' ||
      row.status === 'skipped_no_entitlement' ||
      row.status === 'skipped_quota_exhausted'
    );
  }

  protected runStatusLabel(row: WatchlistRunRow): string {
    switch (row.status) {
      case 'queued':
        return 'Queued';
      case 'processing':
        return 'Running…';
      case 'complete':
        return 'Complete';
      case 'failed':
        return 'Failed';
    }
  }

  protected runSymbol(row: WatchlistRunRow): string {
    return row.instruments?.symbol ?? 'Unknown symbol';
  }

  /** "31 Aug, 14:05" — enough for the user to recognise their own entry. */
  protected formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
