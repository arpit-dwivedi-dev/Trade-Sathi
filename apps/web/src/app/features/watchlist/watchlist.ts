import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

import type { Instrument } from '@chartanalyzer/shared';
import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';

interface WatchlistItem {
  id: string;
  symbol: string;
  instrument_id: string | null;
  enabled_for_daily_analysis: boolean;
  instruments: { exchange: string; symbol: string; name: string } | null;
}

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

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

  protected readonly items = signal<WatchlistItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Watchlist item id currently running an Analyze Now request, if any. */
  protected readonly analyzingId = signal<string | null>(null);
  /** Keyed by watchlist item id, so each row's message is independent. */
  protected readonly analyzeResult = signal<Record<string, string>>({});

  protected readonly queryInput = signal('');
  protected readonly results = signal<Instrument[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly selected = signal<Instrument | null>(null);

  private readonly querySubject = new Subject<string>();

  ngOnInit(): void {
    void this.load();

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
        'id, symbol, instrument_id, enabled_for_daily_analysis, instruments(exchange, symbol, name)',
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
   * Only enabled_for_daily_analysis is writable by clients (see the
   * column-scoped grant in
   * 20260831160000_watchlist_daily_analysis_flag.sql) — everything else
   * about a watch entry is immutable once added.
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
   * Runs the same fetch/chart/AI pipeline as the scheduled daily briefing,
   * for this one symbol, right now — consumes one unit of the same
   * 30/month Daily Briefing quota. Independent of the toggle above and of
   * the once-a-day scheduled email: this never touches daily_briefing_log
   * and sends no email, it just produces one analysis immediately.
   */
  protected async analyzeNow(item: WatchlistItem): Promise<void> {
    if (this.analyzingId()) return;
    this.analyzingId.set(item.id);
    this.analyzeResult.update((results) => {
      const rest = { ...results };
      delete rest[item.id];
      return rest;
    });

    const token = await this.auth.getAccessToken();
    if (!token) {
      this.analyzingId.set(null);
      return;
    }

    try {
      // The API kicks off the fetch/chart/AI pipeline in the background and
      // responds as soon as its fast checks pass (202) — the pipeline itself
      // takes 20-30+ seconds, too long for some proxies/tunnels to hold a
      // request open. We poll the analyses table (readable under RLS)
      // instead of waiting on this call.
      const accepted = await firstValueFrom(
        this.http.post<{ instrumentId: string; startedAt: string }>(
          `/api/watchlist/${item.id}/analyze-now`,
          {},
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      await this.pollForAnalysisResult(item, accepted.instrumentId, accepted.startedAt);
    } catch (cause) {
      let message = 'Analysis failed. Please try again.';
      if (cause instanceof HttpErrorResponse) {
        const body: unknown = cause.error;
        if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
          message = (body as { error: string }).error;
        }
      }
      this.analyzeResult.update((results) => ({ ...results, [item.id]: message }));
      this.analyzingId.set(null);
    }
  }

  private static readonly POLL_INTERVAL_MS = 3000;
  private static readonly POLL_MAX_ATTEMPTS = 30; // ~90s

  /**
   * Waits for the background analysis kicked off by analyze-now to land as a
   * new `analyses` row for this instrument, created at or after the request.
   *
   * instrumentId comes from the 202 response, not from the local row: a
   * watchlist item's own instrument_id is nullable (a symbol-only row), while
   * the analysis is always written against the instrument the API resolved
   * server-side. Filtering on the local value would emit `instrument_id=eq.null`
   * for those rows, which matches nothing, and every run would time out.
   */
  private async pollForAnalysisResult(
    item: WatchlistItem,
    instrumentId: string,
    startedAt: string,
  ): Promise<void> {
    const client = this.supabase.client;
    if (!client) {
      this.analyzingId.set(null);
      return;
    }

    for (let attempt = 0; attempt < Watchlist.POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Watchlist.POLL_INTERVAL_MS));

      const { data, error } = await client
        .from('analyses')
        .select('id, status')
        .eq('instrument_id', instrumentId)
        .eq('source', 'watchlist_daily')
        .gte('created_at', startedAt)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) continue;

      if (data?.status === 'complete') {
        this.analyzeResult.update((results) => ({
          ...results,
          [item.id]: 'Analysis complete — check your history.',
        }));
        this.analyzingId.set(null);
        return;
      }

      if (data?.status === 'failed') {
        this.analyzeResult.update((results) => ({ ...results, [item.id]: 'Analysis failed. Please try again.' }));
        this.analyzingId.set(null);
        return;
      }
    }

    this.analyzeResult.update((results) => ({
      ...results,
      [item.id]: 'Still processing — check your history in a bit.',
    }));
    this.analyzingId.set(null);
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
