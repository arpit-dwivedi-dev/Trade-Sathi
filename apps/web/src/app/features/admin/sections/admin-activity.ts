import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import type { AdminActivity, AdminRange } from '@tradesathi/shared';

import { AppIcon } from '../../../shared/icons/app-icon';
import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import { AdminChart, shortDay, type ChartSeries, type ChartTone } from '../admin-chart';
import { AdminDonut, type DonutSlice } from '../admin-donut';
import { continuousDays, humanize, pct, sourceLabel, statusSeverity } from '../admin-format';

const SEVERITY_TONE: Readonly<Record<string, ChartTone>> = {
  success: 'up',
  danger: 'down',
  warn: 'warn',
  info: 'acc',
};

/** A status → count map as donut slices, coloured by what the status means. */
function statusSlices(counts: Record<string, number> | undefined): DonutSlice[] {
  return Object.entries(counts ?? {})
    .sort(([, a], [, b]) => b - a)
    .map(([key, value]) => ({
      label: humanize(key),
      value,
      tone: SEVERITY_TONE[statusSeverity(key)] ?? 'mute',
    }));
}

@Component({
  selector: 'app-admin-activity',
  imports: [AdminChart, AdminDonut, AppIcon, MessageModule, ProgressSpinnerModule, TableModule],
  templateUrl: './admin-activity.html',
  styleUrl: '../admin-section.css',
})
export class AdminActivitySection {
  private readonly api = inject(AdminApiService);

  readonly range = input.required<AdminRange>();

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminActivity | null>(null);

  protected readonly sourceLabel = sourceLabel;
  protected readonly pct = pct;

  private seq = 0;

  constructor() {
    effect(() => void this.load(this.range()));
  }

  protected readonly chart = computed(() => {
    const trend = this.data()?.analysisTrend ?? [];
    const days = continuousDays(trend.map((p) => p.day));
    const at = (d: string) => trend.find((p) => p.day === d);
    return {
      labels: days.map(shortDay),
      series: [
        { label: 'Succeeded', tone: 'up', data: days.map((d) => (at(d)?.analyses ?? 0) - (at(d)?.failed ?? 0)) },
        { label: 'Failed', tone: 'down', data: days.map((d) => at(d)?.failed ?? 0) },
      ] satisfies ChartSeries[],
    };
  });

  protected readonly typeSlices = computed((): DonutSlice[] =>
    (this.data()?.bySource ?? []).map((s) => ({ label: sourceLabel(s.key), value: s.analyses })),
  );
  protected readonly runSlices = computed(() => statusSlices(this.data()?.watchlist.runs));
  protected readonly briefingSlices = computed(() => statusSlices(this.data()?.briefings));

  protected readonly totalAnalyses = computed(() =>
    (this.data()?.bySource ?? []).reduce((sum, s) => sum + s.analyses, 0),
  );
  protected readonly totalFailed = computed(() =>
    (this.data()?.bySource ?? []).reduce((sum, s) => sum + s.failed, 0),
  );

  protected sum(counts: Record<string, number>): number {
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  private async load(range: AdminRange): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.api.activity(range);
      if (seq === this.seq) this.data.set(data);
    } catch (cause) {
      if (seq === this.seq) this.error.set(adminErrorMessage(cause));
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }
}
