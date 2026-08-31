import { HttpClient } from '@angular/common/http';
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
      .select('id, symbol, instrument_id, instruments(exchange, symbol, name)')
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
