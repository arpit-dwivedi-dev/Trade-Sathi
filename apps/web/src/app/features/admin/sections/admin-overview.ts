import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import type { AdminOverview, AdminRange } from '@tradesathi/shared';

import { AppIcon } from '../../../shared/icons/app-icon';
import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import { AdminChart, shortDay, type ChartSeries } from '../admin-chart';
import { AdminDonut, type DonutSlice } from '../admin-donut';
import { continuousDays, countryName, fxNote, major, money, moneyEntries, pct, pnlIn, usd } from '../admin-format';
import { AdminCurrencyService } from '../admin-currency.service';

@Component({
  selector: 'app-admin-overview',
  imports: [AdminChart, AdminDonut, AppIcon, MessageModule, ProgressSpinnerModule],
  templateUrl: './admin-overview.html',
  styleUrl: '../admin-section.css',
})
export class AdminOverviewSection {
  private readonly api = inject(AdminApiService);
  protected readonly currency = inject(AdminCurrencyService);
  protected readonly pnlCurrency = this.currency.currency;
  protected readonly major = major;
  protected readonly fxNote = fxNote;

  protected readonly pnl = computed(() => {
    const d = this.data();
    if (!d) return null;
    return pnlIn(d.economics.revenue, d.economics.aiCostUsd, d.fx.usdInr, this.pnlCurrency());
  });

  readonly range = input.required<AdminRange>();

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminOverview | null>(null);

  protected readonly usd = usd;
  protected readonly money = money;
  protected readonly moneyEntries = moneyEntries;
  protected readonly pct = pct;
  protected readonly usdFormat = (v: number) => usd(v);
  private seq = 0;

  constructor() {
    effect(() => void this.load(this.range()));
  }

  protected async load(range: AdminRange): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.api.overview(range);
      if (seq === this.seq) this.data.set(data);
    } catch (cause) {
      if (seq === this.seq) this.error.set(adminErrorMessage(cause));
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  /** One revenue chart per currency — never two currencies on one axis. */
  protected readonly revenueCharts = computed(() => {
    const trend = this.data()?.revenueTrend ?? [];
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

  protected readonly analysisChart = computed(() => {
    const trend = this.data()?.analysisTrend ?? [];
    const days = continuousDays(trend.map((p) => p.day));
    const at = (d: string) => trend.find((p) => p.day === d);
    return {
      labels: days.map(shortDay),
      analyses: [
        { label: 'Succeeded', tone: 'up', data: days.map((d) => (at(d)?.analyses ?? 0) - (at(d)?.failed ?? 0)) },
        { label: 'Failed', tone: 'down', data: days.map((d) => at(d)?.failed ?? 0) },
      ] satisfies ChartSeries[],
      cost: [
        { label: 'AI cost (USD)', tone: 'warn', data: days.map((d) => at(d)?.aiCostUsd ?? 0) },
      ] satisfies ChartSeries[],
    };
  });

  protected readonly paymentSlices = computed((): DonutSlice[] => {
    const p = this.data()?.payments;
    if (!p) return [];
    return [
      { label: 'Captured', value: p.capturedCount, tone: 'up' },
      { label: 'Not completed', value: p.createdCount, tone: 'mute' },
      { label: 'Failed', value: p.failedCount, tone: 'down' },
      { label: 'Refunded', value: p.refundedCount, tone: 'warn' },
    ];
  });

  protected readonly funnel = computed(() => {
    const u = this.data()?.users;
    return {
      labels: ['All users', 'New', 'Active', 'Paying'],
      series: [
        { label: 'Users', tone: 'acc', data: u ? [u.total, u.new, u.active, u.paying] : [] },
      ] satisfies ChartSeries[],
    };
  });

  /** Top three countries by users, the rest folded into "Other" — never a generated fifth hue. */
  protected readonly countrySlices = computed((): DonutSlice[] => {
    const byCountry = new Map<string, number>();
    for (const l of this.data()?.locations ?? []) {
      byCountry.set(l.country, (byCountry.get(l.country) ?? 0) + l.users);
    }
    const sorted = [...byCountry.entries()].sort(([, a], [, b]) => b - a);
    const slices: DonutSlice[] = sorted.slice(0, 3).map(([code, users]) => ({ label: countryName(code), value: users }));
    const other = sorted.slice(3).reduce((sum, [, users]) => sum + users, 0);
    if (other > 0) slices.push({ label: 'Other', value: other, tone: 'mute' });
    return slices;
  });

  protected readonly cityChart = computed(() => {
    const byCity = new Map<string, number>();
    for (const l of this.data()?.locations ?? []) {
      if (!l.city) continue;
      const key = `${l.city}, ${l.country}`;
      byCity.set(key, (byCity.get(key) ?? 0) + l.users);
    }
    const top = [...byCity.entries()].sort(([, a], [, b]) => b - a).slice(0, 8);
    return {
      labels: top.map(([city]) => city),
      series: [{ label: 'Users', tone: 'acc', data: top.map(([, users]) => users) }] satisfies ChartSeries[],
      height: Math.max(140, top.length * 34 + 40),
    };
  });

}
