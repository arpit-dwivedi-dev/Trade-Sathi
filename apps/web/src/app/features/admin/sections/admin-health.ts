import { Component, inject, signal } from '@angular/core';
import { MessageModule } from 'primeng/message';
import { PaginatorModule, type PaginatorState } from 'primeng/paginator';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import type { AdminHealth } from '@tradesathi/shared';

import { AppIcon } from '../../../shared/icons/app-icon';
import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import { dateTime, humanize, money, sourceLabel, stClass } from '../admin-format';

const PAGE_SIZE = 25;

/**
 * "Is something broken right now?" — recent app errors, failed analyses, and
 * payments that never left 'created'. Not date-ranged: it is about now.
 */
@Component({
  selector: 'app-admin-health',
  imports: [AppIcon, MessageModule, PaginatorModule, ProgressSpinnerModule, TableModule],
  templateUrl: './admin-health.html',
  styleUrl: '../admin-section.css',
})
export class AdminHealthSection {
  private readonly api = inject(AdminApiService);

  protected readonly first = signal(0);
  protected readonly pageSize = PAGE_SIZE;

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminHealth | null>(null);

  protected readonly dateTime = dateTime;
  protected readonly humanize = humanize;
  protected readonly money = money;
  protected readonly sourceLabel = sourceLabel;
  protected readonly stClass = stClass;

  private seq = 0;

  constructor() {
    void this.load();
  }

  protected onPage(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    void this.load();
  }

  protected detailText(detail: unknown): string {
    if (detail === null || detail === undefined) return '';
    return typeof detail === 'string' ? detail : JSON.stringify(detail);
  }

  protected async load(): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.api.health({ limit: PAGE_SIZE, offset: this.first() });
      if (seq === this.seq) this.data.set(data);
    } catch (cause) {
      if (seq === this.seq) this.error.set(adminErrorMessage(cause));
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }
}
