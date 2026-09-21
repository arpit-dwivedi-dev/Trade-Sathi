import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MessageModule } from 'primeng/message';
import { PaginatorModule, type PaginatorState } from 'primeng/paginator';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import type { AdminPayments, AdminRange } from '@tradesathi/shared';

import { AppIcon } from '../../../shared/icons/app-icon';
import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import { AdminChart, shortDay, type ChartSeries } from '../admin-chart';
import { AdminDonut, type DonutSlice } from '../admin-donut';
import { continuousDays, dateTime, money, moneyEntries, pct, stClass } from '../admin-format';

const PAGE_SIZE = 25;

/** payments.status values — see the payments table's migration. */
const STATUSES = ['created', 'captured', 'failed', 'refunded'];
const STATUS_LABELS: Readonly<Record<string, string>> = {
  created: 'Not completed',
  captured: 'Captured',
  failed: 'Failed',
  refunded: 'Refunded',
};
const CURRENCIES = ['INR', 'USD'];

@Component({
  selector: 'app-admin-payments',
  imports: [
    AdminChart,
    AdminDonut,
    AppIcon,
    FormsModule,
    MessageModule,
    PaginatorModule,
    ProgressSpinnerModule,
    SelectModule,
    TableModule,
  ],
  templateUrl: './admin-payments.html',
  styleUrl: '../admin-section.css',
})
export class AdminPaymentsSection {
  private readonly api = inject(AdminApiService);

  readonly range = input.required<AdminRange>();

  protected readonly status = signal<string | null>(null);
  protected readonly currency = signal<string | null>(null);
  protected readonly first = signal(0);
  protected readonly pageSize = PAGE_SIZE;
  protected readonly statusOptions = STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }));
  protected readonly currencyOptions = CURRENCIES.map((value) => ({ value, label: value }));

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminPayments | null>(null);

  protected readonly money = money;
  protected readonly moneyEntries = moneyEntries;
  protected readonly dateTime = dateTime;
  protected readonly stClass = stClass;
  protected readonly pct = pct;

  protected statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
  }

  protected readonly statusSlices = computed((): DonutSlice[] => {
    const s = this.data()?.summary;
    if (!s) return [];
    return [
      { label: 'Captured', value: s.capturedCount, tone: 'up' },
      { label: 'Not completed', value: s.createdCount, tone: 'mute' },
      { label: 'Failed', value: s.failedCount, tone: 'down' },
      { label: 'Refunded', value: s.refundedCount, tone: 'warn' },
    ];
  });

  private seq = 0;

  constructor() {
    effect(() => {
      this.range();
      this.status();
      this.currency();
      untracked(() => {
        this.first.set(0);
        void this.load();
      });
    });
  }

  /** One chart per currency. */
  protected readonly charts = computed(() => {
    const trend = this.data()?.trend ?? [];
    const days = continuousDays(trend.map((p) => p.day));
    const currencies = [...new Set(trend.flatMap((p) => Object.keys(p.revenue)))].sort();
    return currencies.map((currency) => ({
      currency,
      labels: days.map(shortDay),
      series: [
        {
          label: `Revenue (${currency})`,
          tone: 'up',
          data: days.map((d) => (trend.find((p) => p.day === d)?.revenue[currency] ?? 0) / 100),
        },
      ] satisfies ChartSeries[],
      format: (v: number) => money(v * 100, currency),
    }));
  });

  protected onPage(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    void this.load();
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.api.payments({
        range: this.range(),
        status: this.status(),
        currency: this.currency(),
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
