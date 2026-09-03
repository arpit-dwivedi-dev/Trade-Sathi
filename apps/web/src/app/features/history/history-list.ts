import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import { ChartImage } from '../../shared/chart-image';
import { AnalysisResult } from '../analyze/analysis-result';
import { AnalysisPdfService } from './analysis-pdf.service';
import {
  HistoryService,
  type HistoryDetail,
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
    AnalysisResult,
    ChartImage,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTableModule,
  ],
  templateUrl: './history-list.html',
  styleUrl: './history-list.css',
})
export class HistoryList implements OnInit, OnDestroy {
  private readonly history = inject(HistoryService);
  private readonly pdf = inject(AnalysisPdfService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);

  protected readonly columns = ['analyzed', 'symbol', 'asset', 'tf', 'trend', 'direction', 'status', 'actions'];

  protected readonly rows = signal<HistoryRow[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  /** True for the first load only, so "Load more" doesn't blank the list. */
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);

  /** id of the row whose detail is expanded, or null when all are collapsed. */
  protected readonly expandedId = signal<string | null>(null);
  /** matRowDef's `when` predicate for the expandedDetail row — only the
   *  currently-open row's detail row exists in the DOM at all. */
  protected readonly isExpandedRow = (_index: number, row: HistoryRow): boolean =>
    row.id === this.expandedId();

  /**
   * CdkTable only re-evaluates matRowDef's `when` predicates when the bound
   * [dataSource] reference itself changes — toggling expandedId doesn't
   * touch `rows`, so binding [dataSource] to `rows()` directly would flip
   * the chevron with no expanded row ever actually appearing. Reading
   * expandedId() here and returning a fresh array is what makes the table
   * notice and re-render on every toggle.
   */
  protected readonly tableRows = computed(() => {
    this.expandedId();
    return [...this.rows()];
  });
  protected readonly detail = signal<HistoryDetail | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);

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
   * are prepended, so scroll position and the expanded row both survive.
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
    // The open row may not be in the new listing at all; collapsing avoids a
    // detail panel hanging under a list that no longer contains its row.
    this.expandedId.set(null);
    this.detail.set(null);
    this.rows.set([]);
    this.nextCursor.set(null);
    await this.loadFirstPage();
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

  /**
   * Expands a row into its full analysis, collapsing it again if it was already
   * open. Only one row is expanded at a time, so a single detail slot is enough.
   */
  protected async toggle(row: HistoryRow): Promise<void> {
    if (this.expandedId() === row.id) {
      this.expandedId.set(null);
      this.detail.set(null);
      this.detailError.set(null);
      this.detailLoading.set(false);
      return;
    }

    this.expandedId.set(row.id);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(true);
    try {
      const detail = await this.history.fetchDetail(row.id);
      // A slower fetch for a row the user has since collapsed (or swapped away
      // from) must not paint into the newly expanded one.
      if (this.expandedId() !== row.id) return;
      this.detail.set(detail);
    } catch (cause) {
      console.warn('analysis detail fetch failed', cause);
      if (this.expandedId() !== row.id) return;
      this.detailError.set("Couldn't load this analysis. Try again.");
    } finally {
      if (this.expandedId() === row.id) this.detailLoading.set(false);
    }
  }

  /**
   * Exports one analysis as a PDF. Works from the list row rather than only
   * from an expanded detail, so it refetches the full row when the expanded
   * detail is not the one being exported.
   */
  protected async exportPdf(row: HistoryRow, event: Event): Promise<void> {
    // The row is a <button> that toggles the detail; exporting must not also
    // expand or collapse it.
    event.stopPropagation();
    if (this.exportingId()) return;

    this.exportingId.set(row.id);
    this.exportError.set(null);
    try {
      const loaded = this.detail();
      const detail =
        loaded && loaded.row.id === row.id ? loaded : await this.history.fetchDetail(row.id);
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

  /** Provenance in the user's terms — see AnalysisResult.sourceLabel. */
  protected sourceLabel(row: HistoryRow): string {
    switch (row.source) {
      case 'live':
        return 'live chart';
      case 'watchlist_daily':
        return 'daily briefing';
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
