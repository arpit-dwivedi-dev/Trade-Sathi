import { Component, OnInit, inject, signal } from '@angular/core';

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
  templateUrl: './logs-page.html',
  styleUrl: './logs-page.css',
})
export class LogsPage implements OnInit {
  private readonly supabase = inject(SupabaseClientService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly briefingLog = signal<BriefingLogRow[]>([]);
  protected readonly watchlistRuns = signal<WatchlistRunRow[]>([]);
  protected readonly errorLog = signal<ErrorLogRow[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;

    this.loading.set(true);
    this.error.set(null);

    const [briefing, runs, errors] = await Promise.all([
      client
        .from('daily_briefing_log')
        .select('id, briefing_date, run_hour_ist, run_minute_ist, status, symbols_sent, symbols_failed, updated_at')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
      client
        .from('watchlist_analysis_runs')
        .select('id, status, lookback_days, created_at, instruments(symbol, name)')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
      client
        .from('app_error_logs')
        .select('id, category, message, detail, created_at')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
    ]);

    if (briefing.error || runs.error || errors.error) {
      this.error.set('Could not load your logs.');
    } else {
      this.briefingLog.set((briefing.data ?? []) as unknown as BriefingLogRow[]);
      this.watchlistRuns.set((runs.data ?? []) as unknown as WatchlistRunRow[]);
      this.errorLog.set((errors.data ?? []) as unknown as ErrorLogRow[]);
    }
    this.loading.set(false);
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
