import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MessageModule } from 'primeng/message';
import { PaginatorModule, type PaginatorState } from 'primeng/paginator';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import type { AdminAnalysisRow, AdminEconomics, AdminRange } from '@tradesathi/shared';

import { AppIcon } from '../../../shared/icons/app-icon';
import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import { AdminChart, type ChartSeries } from '../admin-chart';
import { AdminDonut, type DonutSlice } from '../admin-donut';
import { dateTime, fxNote, humanize, major, money, moneyEntries, pnlIn, sourceLabel, stClass, usd } from '../admin-format';
import { AdminCurrencyService } from '../admin-currency.service';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-admin-economics',
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
  templateUrl: './admin-economics.html',
  styleUrl: '../admin-section.css',
})
export class AdminEconomicsSection {
  private readonly api = inject(AdminApiService);
  protected readonly currency = inject(AdminCurrencyService);
  protected readonly pnlCurrency = this.currency.currency;
  protected readonly major = major;
  protected readonly fxNote = fxNote;

  protected readonly pnl = computed(() => {
    const d = this.data();
    if (!d) return null;
    return pnlIn(d.totals.revenue, d.totals.aiCostUsd, d.fx.usdInr, this.pnlCurrency());
  });

  protected rowPnl(row: AdminAnalysisRow, usdInr: number | null): number | null {
    const revenue = row.currency ? { [row.currency]: row.revenueMinor } : {};
    return pnlIn(revenue, row.costUsd, usdInr, this.pnlCurrency());
  }

  readonly range = input.required<AdminRange>();

  protected readonly source = signal<string | null>(null);
  protected readonly model = signal<string | null>(null);
  protected readonly status = signal<string | null>(null);
  protected readonly first = signal(0);
  protected readonly pageSize = PAGE_SIZE;

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminEconomics | null>(null);

  protected readonly usd = usd;
  protected readonly money = money;
  protected readonly moneyEntries = moneyEntries;
  protected readonly dateTime = dateTime;
  protected readonly sourceLabel = sourceLabel;
  protected readonly humanize = humanize;
  protected readonly stClass = stClass;
  protected readonly usdFormat = (v: number) => usd(v);

  protected readonly filtered = computed(() => !!(this.source() || this.model() || this.status()));

  protected readonly typeSlices = computed((): DonutSlice[] =>
    (this.data()?.bySource ?? []).map((r) => ({ label: sourceLabel(r.key), value: r.analyses })),
  );

  /** Top models by cost; a bar per model, so the height follows the count. */
  protected readonly modelChart = computed(() => {
    const rows = [...(this.data()?.byModel ?? [])].sort((a, b) => b.aiCostUsd - a.aiCostUsd).slice(0, 8);
    return {
      labels: rows.map((r) => r.key),
      series: [{ label: 'AI cost', tone: 'warn', data: rows.map((r) => r.aiCostUsd) }] satisfies ChartSeries[],
      height: Math.max(140, rows.length * 34 + 40),
    };
  });

  private seq = 0;

  constructor() {
    // A new range or filter starts again from the first page.
    effect(() => {
      this.range();
      this.source();
      this.model();
      this.status();
      untracked(() => {
        this.first.set(0);
        void this.load();
      });
    });
  }

  protected clearFilters(): void {
    this.source.set(null);
    this.model.set(null);
    this.status.set(null);
  }

  protected onPage(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    void this.load();
  }

  protected options(values: readonly string[], label: (v: string) => string = (v) => v) {
    return values.map((value) => ({ value, label: label(value) }));
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.api.economics({
        range: this.range(),
        source: this.source(),
        model: this.model(),
        status: this.status(),
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
