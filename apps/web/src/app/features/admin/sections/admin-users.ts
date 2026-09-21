import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DrawerModule } from 'primeng/drawer';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { PaginatorModule, type PaginatorState } from 'primeng/paginator';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import type { AdminPage, AdminUserDetail, AdminUserRow } from '@tradesathi/shared';

import { AppIcon } from '../../../shared/icons/app-icon';
import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import {
  date,
  dateTime,
  humanize,
  money,
  moneyEntries,
  place,
  sourceLabel,
  stClass,
  usd,
} from '../admin-format';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-admin-users',
  imports: [
    AppIcon,
    DrawerModule,
    FormsModule,
    InputTextModule,
    MessageModule,
    PaginatorModule,
    ProgressSpinnerModule,
    TableModule,
    TabsModule,
  ],
  templateUrl: './admin-users.html',
  styleUrl: '../admin-section.css',
})
export class AdminUsersSection {
  private readonly api = inject(AdminApiService);

  protected readonly search = signal('');
  protected readonly first = signal(0);
  protected readonly pageSize = PAGE_SIZE;

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminPage<AdminUserRow> | null>(null);

  protected readonly detailOpen = signal(false);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);
  protected readonly detail = signal<AdminUserDetail | null>(null);

  protected readonly date = date;
  protected readonly dateTime = dateTime;
  protected readonly humanize = humanize;
  protected readonly money = money;
  protected readonly moneyEntries = moneyEntries;
  protected readonly place = place;
  protected readonly sourceLabel = sourceLabel;
  protected readonly stClass = stClass;
  protected readonly usd = usd;

  private seq = 0;
  private detailSeq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.load();
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
  }

  protected onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.first.set(0);
      void this.load();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onPage(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    void this.load();
  }

  protected async open(user: AdminUserRow): Promise<void> {
    const seq = ++this.detailSeq;
    this.detailOpen.set(true);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(true);
    try {
      const detail = await this.api.user(user.id);
      if (seq === this.detailSeq) this.detail.set(detail);
    } catch (cause) {
      if (seq === this.detailSeq) this.detailError.set(adminErrorMessage(cause));
    } finally {
      if (seq === this.detailSeq) this.detailLoading.set(false);
    }
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.api.users({
        search: this.search().trim(),
        limit: PAGE_SIZE,
        offset: this.first(),
      });
      if (seq === this.seq) this.data.set(data);
    } catch (cause) {
      if (seq === this.seq) this.error.set(adminErrorMessage(cause));
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }
}
