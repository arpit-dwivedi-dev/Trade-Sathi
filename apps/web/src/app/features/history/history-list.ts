import { Component, OnInit, inject, signal } from '@angular/core';

import { HistoryService, type HistoryRow } from './history.service';

/**
 * The signed-in user's past analyses, newest first.
 *
 * Keeps its own fetch/pagination state and its own rendering. A separate
 * container component would buy nothing at two components; split it when a
 * second consumer of this list actually appears.
 */
@Component({
  selector: 'app-history-list',
  templateUrl: './history-list.html',
  styleUrl: './history-list.css',
})
export class HistoryList implements OnInit {
  private readonly history = inject(HistoryService);

  protected readonly rows = signal<HistoryRow[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  /** True for the first load only, so "Load more" doesn't blank the list. */
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);

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
