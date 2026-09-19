import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import { AppIcon } from '../../shared/icons/app-icon';
import { TimeframeLabelPipe } from '../../shared/timeframe-label.pipe';
import type {
  OpenInstrumentRequest,
  ChartDestinationTab,
} from '../app/open-instrument';
import { AnalysisPdfService } from './analysis-pdf.service';
import {
  HistoryService,
  type HistoryRow,
  type HistorySourceFilter,
} from './history.service';

/**
 * The signed-in user's past analyses, newest first.
 *
 * Keeps its own fetch/pagination state and its own rendering. A separate
 * container component would buy nothing at two components; split it when a
 * second consumer of this list actually appears.
 */
@Component({
  selector: 'app-history-list',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AppIcon,
    ButtonModule,
    CardModule,
    FormsModule,
    ProgressSpinnerModule,
    SelectButtonModule,
    TableModule,
    TimeframeLabelPipe,
  ],
  templateUrl: './history-list.html',
  styleUrl: './history-list.css',
})
export class HistoryList implements OnInit, OnDestroy {
  private readonly history = inject(HistoryService);
  private readonly pdf = inject(AnalysisPdfService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);

  /**
   * Asks the shell to reopen a resolved row's instrument on the tab that row
   * belongs to — the Fundamentals tab for a fundamentals analysis, the
   * Analyze-by-Symbol chart workspace for every chart analysis. Raised only
   * when the row resolved to a catalogue instrument; unresolvable rows render
   * no link (see reopenTarget).
   */
  readonly openInstrument = output<OpenInstrumentRequest>();

  protected readonly columns = [
    'logo',
    'symbol',
    'structure',
    'setup',
    'tf',
    'analyzed',
    'status',
    'actions',
  ];

  protected readonly deleting = signal(false);
  protected readonly deleteError = signal<string | null>(null);

  protected readonly rows = signal<HistoryRow[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  /** True for the first load only, so "Load more" doesn't blank the list. */
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);

  /**
   * Which provenance the list is restricted to. Applied server-side and reset
   * to the first page on every change, because the cursor encodes a position
   * within one particular filtered ordering.
   */
  protected readonly sourceFilter = signal<HistorySourceFilter>('all');

  protected readonly sourceFilters: { value: HistorySourceFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'manual', label: 'Uploads' },
    { value: 'live', label: 'Live' },
    { value: 'watchlist_daily', label: 'Daily briefing' },
    { value: 'fundamentals', label: 'Fundamentals' },
  ];

  /**
   * The zero-height marker rendered just past the last row, only while a next
   * page exists. Watching it is what drives paging now that the table has no
   * scrollbox of its own to listen to — and unlike a scroll offset it also
   * fires when the loaded rows do not yet fill the viewport, so a short first
   * page keeps filling instead of waiting for a scroll that never comes.
   */
  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('loadMoreSentinel');
  private observer: IntersectionObserver | null = null;

  /** id of the row whose PDF is being generated, or null when none is. */
  protected readonly exportingId = signal<string | null>(null);
  protected readonly exportError = signal<string | null>(null);

  /** Realtime subscription to this profile's analyses; null during SSR. */
  private analysesChannel: RealtimeChannel | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /**
   * Coalescing window for Realtime events. One analysis writes its row at
   * least twice (queued, then complete), and a finishing daily briefing
   * writes one per watched symbol within a second or two — refetching the
   * first page per event would be a burst of identical queries.
   */
  private static readonly REFRESH_DEBOUNCE_MS = 400;

  constructor() {
    // Re-runs whenever the sentinel enters or leaves the DOM: it is absent
    // during loading, on the empty states, and once the last page has been
    // read, and this tears the observer down with it in every one of those
    // cases. Guarded for SSR, where there is no IntersectionObserver.
    effect(() => {
      const element = this.sentinel()?.nativeElement;
      this.observer?.disconnect();
      this.observer = null;
      if (!element || typeof IntersectionObserver === 'undefined') return;

      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) void this.loadMore();
        },
        // Starts the fetch a screenful early, so the next rows are usually
        // already there by the time the user scrolls to where they go.
        { rootMargin: '240px' },
      );
      this.observer.observe(element);
    });
  }

  ngOnInit(): void {
    void this.loadFirstPage();
    this.watchAnalyses();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.analysesChannel) {
      void this.supabase.client?.removeChannel(this.analysesChannel);
      this.analysesChannel = null;
    }
  }

  /**
   * Keeps the list current without the user reloading the page.
   *
   * History was the one place a finished analysis did not reach on its own:
   * an upload watched its own row on the Analyze page, but the moment the
   * user switched to History the list was a snapshot of whatever was true
   * when it mounted, so a completing upload, a live run or a daily briefing
   * only appeared on a manual refresh. RLS scopes the subscription
   * server-side; the profile filter is still passed so this socket is not
   * asked to carry rows for anyone else in the first place.
   */
  private watchAnalyses(): void {
    const client = this.supabase.client;
    const profileId = this.auth.user()?.id;
    if (!client || !profileId) return;

    this.analysesChannel = client
      .channel(`history-analyses-${profileId}`)
      .on(
        'postgres_changes',
        {
          // INSERT (a run appearing) and UPDATE (one settling) both change
          // what this list should show.
          event: '*',
          schema: 'public',
          table: 'analyses',
          filter: `profile_id=eq.${profileId}`,
        },
        () => this.scheduleRefresh(),
      )
      .subscribe();
  }

  private scheduleRefresh(): void {
    if (this.destroyed || this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshFirstPage();
    }, HistoryList.REFRESH_DEBOUNCE_MS);
  }

  /**
   * Re-reads the first page and merges it into what is already displayed.
   *
   * Deliberately not a reload: the user may have paged well past the first
   * page, and dropping those rows under them is worse than a slightly stale
   * tail. Rows already held are updated in place (a 'queued' row becoming
   * 'complete' is exactly the case this exists for) and genuinely new ones
   * are prepended, so scroll position and the current list position survive.
   */
  private async refreshFirstPage(): Promise<void> {
    // A page load or a "Load more" in flight owns `rows` and its cursor;
    // merging underneath it would fight for the same state. The next event
    // refreshes anyway, and a first load is itself already current.
    if (this.destroyed || this.loading() || this.loadingMore()) return;

    try {
      const page = await this.history.fetchHistory(undefined, undefined, this.sourceFilter());
      if (this.destroyed) return;

      this.rows.update((existing) => {
        const held = new Set(existing.map((row) => row.id));
        const updated = new Map(page.rows.map((row) => [row.id, row] as const));
        const merged = existing.map((row) => updated.get(row.id) ?? row);
        return [...page.rows.filter((row) => !held.has(row.id)), ...merged];
      });

      // Only meaningful while the first page is also the last one; once the
      // user has paged on, the cursor they hold is further down the list.
      this.nextCursor.update((cursor) => cursor ?? page.nextCursor);
    } catch (cause) {
      // Silent on purpose: the list on screen is still valid, and the next
      // event (or the user's own refresh) retries. Replacing it with an error
      // banner would be a regression for a background read nobody asked for.
      console.warn('history refresh failed', cause);
    }
  }

  private async loadFirstPage(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.history.fetchHistory(undefined, undefined, this.sourceFilter());
      this.rows.set(page.rows);
      this.nextCursor.set(page.nextCursor);
    } catch (cause) {
      console.warn('history fetch failed', cause);
      this.error.set("Couldn't load your history. Try refreshing the page.");
    } finally {
      this.loading.set(false);
    }
  }

  protected async selectSource(source: HistorySourceFilter): Promise<void> {
    if (this.sourceFilter() === source) return;
    this.sourceFilter.set(source);
    this.rows.set([]);
    this.nextCursor.set(null);
    this.deleteError.set(null);
    await this.loadFirstPage();
  }

  /** Deletes a single row via the row action. */
  protected async deleteOne(row: HistoryRow): Promise<void> {
    if (this.deleting()) return;
    if (!confirm('Delete this analysis? This cannot be undone.')) return;

    this.deleting.set(true);
    this.deleteError.set(null);
    try {
      await this.history.deleteAnalyses([row.id]);
      this.rows.update((existing) => existing.filter((r) => r.id !== row.id));
    } catch (cause) {
      console.warn('history delete failed', cause);
      this.deleteError.set("Couldn't delete. Try again.");
    } finally {
      this.deleting.set(false);
    }
  }

  /** True for rows a briefing email actually carried out to the user. */
  protected wasEmailed(row: HistoryRow): boolean {
    return row.emailed_at !== null;
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;

    this.loadingMore.set(true);
    this.error.set(null);
    let loaded = false;
    try {
      const page = await this.history.fetchHistory(cursor, undefined, this.sourceFilter());
      this.rows.update((existing) => [...existing, ...page.rows]);
      this.nextCursor.set(page.nextCursor);
      loaded = true;
    } catch (cause) {
      console.warn('history page fetch failed', cause);
      this.error.set("Couldn't load more. Try again.");
    } finally {
      this.loadingMore.set(false);
    }

    // The sentinel does not move out of view just because rows were added
    // above it — on a tall screen it can still be sitting inside the root
    // margin, and IntersectionObserver only reports *changes*, so the next
    // page would never be asked for. Re-observing replays the current
    // intersection state and keeps the list filling until it either overflows
    // the viewport or runs out. Only after a page that actually arrived: doing
    // it after a failure would turn one failed fetch into a retry loop against
    // whatever is broken.
    if (!loaded) return;
    const element = this.sentinel()?.nativeElement;
    if (element && this.observer) {
      this.observer.unobserve(element);
      this.observer.observe(element);
    }
  }

  /** Exports one analysis as a PDF from the list row. */
  protected async exportPdf(row: HistoryRow): Promise<void> {
    if (this.exportingId()) return;

    this.exportingId.set(row.id);
    this.exportError.set(null);
    try {
      const detail = await this.history.fetchDetail(row.id);
      await this.pdf.download(detail.row, detail.patterns);
    } catch (cause) {
      console.warn('analysis pdf export failed', cause);
      this.exportError.set("Couldn't build the PDF. Try again.");
    } finally {
      this.exportingId.set(null);
    }
  }

  /**
   * The best name available for a row: the canonical symbol when the analysis
   * has one (every generated analysis does), otherwise whatever the model read
   * off the image. Only a manual upload the model could not read falls through
   * to "Not detected".
   */
  protected displaySymbol(row: HistoryRow): string | null {
    return row.symbol ?? row.symbol_raw;
  }

  /** Company name from the joined catalogue instrument; null for a manual upload. */
  protected companyName(row: HistoryRow): string | null {
    return row.instruments?.name ?? null;
  }

  /**
   * The destination for a resolved row: an instrument built from the joined
   * catalogue row plus which shell tab to open it on. Null when the row has no
   * resolved instrument (a manual upload the model could not map to a
   * catalogue symbol) — those rows are not reopenable and render no link.
   *
   * A fundamentals analysis reads a company, so it is reopened on the
   * Fundamentals tab; every other analysis is of a chart, so it is reopened on
   * the Analyze-by-Symbol workspace.
   */
  protected reopenTarget(row: HistoryRow): OpenInstrumentRequest | null {
    const instrument = row.instruments;
    if (!instrument) return null;
    const tab: ChartDestinationTab =
      row.source === 'fundamentals' ? 'fundamentals' : 'symbol-search';
    return {
      instrument: {
        id: instrument.id,
        exchange: instrument.exchange,
        symbol: instrument.symbol,
        name: instrument.name,
        instrumentType: instrument.instrument_type,
        logoUrl: instrument.logo_url ?? undefined,
      },
      tab,
    };
  }

  /**
   * Whether a row's company/logo are clickable — true only for rows with a
   * resolved instrument. The template calls this to decide between rendering a
   * link and plain text.
   */
  protected canReopen(row: HistoryRow): boolean {
    return this.reopenTarget(row) !== null;
  }

  /** Reopens a resolved row on its destination tab. */
  protected reopen(row: HistoryRow): void {
    const target = this.reopenTarget(row);
    if (target) this.openInstrument.emit(target);
  }

  /** Link label naming the symbol and where clicking takes it. */
  protected reopenLabel(row: HistoryRow): string {
    const symbol = this.displaySymbol(row) ?? this.companyName(row) ?? 'this analysis';
    return `Open ${symbol} on the ${this.reopenTarget(row)?.tab === 'fundamentals' ? 'Fundamentals' : 'Analyze by Symbol'} tab`;
  }

  protected logoUrl(row: HistoryRow): string | null {
    return row.instruments?.logo_url ?? null;
  }

  /**
   * Two-letter fallback avatar for a row with no resolved logo — same
   * initials-from-symbol approach as SymbolSearch, so a symbol renders
   * identically wherever it appears.
   */
  protected initials(row: HistoryRow): string {
    return (this.displaySymbol(row) ?? '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  }

  private static readonly AVATAR_COLORS = [
    '#2563eb',
    '#7c3aed',
    '#db2777',
    '#dc2626',
    '#d97706',
    '#65a30d',
    '#059669',
    '#0891b2',
  ];

  /** Deterministic color pick so the same symbol always renders the same. */
  protected avatarColor(row: HistoryRow): string {
    const key = this.displaySymbol(row) ?? '';
    let hash = 0;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const colors = HistoryList.AVATAR_COLORS;
    return colors[Math.abs(hash) % colors.length];
  }

  /** The server already validated the logo URL; hide it on a transient failure rather than show a broken image. */
  protected onLogoError(event: Event): void {
    (event.target as HTMLImageElement).style.visibility = 'hidden';
  }

  /**
   * Structure at the right edge — 'uptrend', 'range' and so on.
   *
   * Not the same reading the old `trend` column held: that was a
   * bullish/bearish/neutral opinion, this describes the swing structure. They
   * share a column in the list because they answer the same question for a
   * reader scanning it, and no row has both.
   */
  protected structureLabel(row: HistoryRow): string {
    return row.structure_state ?? row.trend ?? '—';
  }

  /**
   * What the setup came to, in one word.
   *
   * A two-scenario read stores no call_direction on purpose: it exists
   * precisely because both edges are live and the chart does not say which
   * resolves, so naming one of them here would invent a call. 'none' is an
   * abstention, which under these prompts is a result rather than a gap.
   *
   * A fundamentals row has no setup at all — its "setup" cell reads the
   * executive verdict's stance instead, which is the closest thing it has to
   * a one-word takeaway.
   */
  protected setupLabel(row: HistoryRow): string | null {
    if (row.source === 'fundamentals') {
      return row.fundamentals_stance?.replace(/_/g, ' ') ?? null;
    }
    if (row.setup_format === 'two_scenario') return 'two-way';
    if (row.setup_format === 'none') return 'no setup';
    return row.call_direction;
  }

  /** The `d-*` class that colours the setup cell, or null for a neutral one. */
  protected setupTone(row: HistoryRow): string | null {
    if (row.source === 'fundamentals') return null;
    if (row.setup_format === 'two_scenario') return null;
    return row.call_direction;
  }

  /** Provenance in the user's terms — see AnalysisResult.sourceLabel. */
  protected sourceLabel(row: HistoryRow): string {
    switch (row.source) {
      case 'live':
        return 'live chart';
      case 'watchlist_daily':
        return 'daily briefing';
      case 'fundamentals':
        return 'fundamentals';
      default:
        return row.source_type;
    }
  }

  /** Coarse relative date — good enough for a list, no date library needed. */
  protected relativeDate(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '—';

    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;

    return new Date(iso).toLocaleDateString();
  }
}
