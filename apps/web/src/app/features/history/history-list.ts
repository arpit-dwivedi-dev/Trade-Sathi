import { Component, OnInit, inject, signal } from '@angular/core';

import { ChartImage } from '../../shared/chart-image';
import { AnalysisResult } from '../analyze/analysis-result';
import { AnalysisPdfService } from './analysis-pdf.service';
import { HistoryService, type HistoryDetail, type HistoryRow } from './history.service';

/**
 * The signed-in user's past analyses, newest first.
 *
 * Keeps its own fetch/pagination state and its own rendering. A separate
 * container component would buy nothing at two components; split it when a
 * second consumer of this list actually appears.
 */
@Component({
  selector: 'app-history-list',
  imports: [AnalysisResult, ChartImage],
  templateUrl: './history-list.html',
  styleUrl: './history-list.css',
})
export class HistoryList implements OnInit {
  private readonly history = inject(HistoryService);
  private readonly pdf = inject(AnalysisPdfService);

  protected readonly rows = signal<HistoryRow[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  /** True for the first load only, so "Load more" doesn't blank the list. */
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);

  /** id of the row whose detail is expanded, or null when all are collapsed. */
  protected readonly expandedId = signal<string | null>(null);
  protected readonly detail = signal<HistoryDetail | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);

  /** id of the row whose PDF is being generated, or null when none is. */
  protected readonly exportingId = signal<string | null>(null);
  protected readonly exportError = signal<string | null>(null);

  ngOnInit(): void {
    void this.loadFirstPage();
  }

  private async loadFirstPage(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.history.fetchHistory();
      this.rows.set(page.rows);
      this.nextCursor.set(page.nextCursor);
    } catch (cause) {
      console.warn('history fetch failed', cause);
      this.error.set("Couldn't load your history. Try refreshing the page.");
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;

    this.loadingMore.set(true);
    this.error.set(null);
    try {
      const page = await this.history.fetchHistory(cursor);
      this.rows.update((existing) => [...existing, ...page.rows]);
      this.nextCursor.set(page.nextCursor);
    } catch (cause) {
      console.warn('history page fetch failed', cause);
      this.error.set("Couldn't load more. Try again.");
    } finally {
      this.loadingMore.set(false);
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
