import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Component, PLATFORM_ID, computed, inject, input } from '@angular/core';
import { ChartModule } from 'primeng/chart';

import { ThemeService } from '../../core/theme.service';

/**
 * Colour roles. up/down/warn are status colours (success, failure, cost) and
 * only ever mean that; c1–c4 are the categorical order for identity (analysis
 * type, model), assigned by position and never cycled.
 */
export type ChartTone = 'acc' | 'up' | 'down' | 'warn' | 'mute' | 'c1' | 'c2' | 'c3' | 'c4';

export interface ChartSeries {
  label: string;
  data: number[];
  tone?: ChartTone;
}

/** Categorical order, validated for CVD separation against both surfaces. */
export const CATEGORICAL: readonly ChartTone[] = ['c1', 'c2', 'c3', 'c4'];

const FALLBACK: Readonly<Record<string, string>> = {
  acc: '#2962ff',
  up: '#089981',
  down: '#f23645',
  warn: '#e07000',
  'tx-3': '#787b86',
  'line-soft': '#eef0f6',
  surf: '#ffffff',
};

/**
 * Every chart in the Admin panel, on the Chart.js that p-chart already brings
 * in for Fundamentals. Colours are read off tokens.css and re-read on a theme
 * switch, so charts follow the app's palette in both modes.
 *
 * One chart is one unit of measure: callers pass a single currency or a count,
 * never two currencies on one axis.
 */
@Component({
  selector: 'app-admin-chart',
  imports: [ChartModule],
  template: `
    <div class="admin-chart" [style.height.px]="height()">
      <p-chart [type]="chartType()" height="100%" [data]="chartData()" [options]="chartOptions()" />
    </div>
  `,
  styles: `
    .admin-chart {
      position: relative;
      width: 100%;
    }
  `,
})
export class AdminChart {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly theme = inject(ThemeService).theme;

  readonly type = input<'bar' | 'line' | 'doughnut' | 'hbar'>('bar');
  readonly labels = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();
  /** Doughnut only: one tone per slice, in label order. */
  readonly tones = input<ChartTone[]>([]);
  readonly format = input<(value: number) => string>((value) => value.toLocaleString());
  readonly height = input(240);
  /** Stack multi-series bars (parts of one whole) instead of grouping them. */
  readonly stacked = input(true);

  protected readonly chartType = computed(() => {
    const type = this.type();
    return type === 'hbar' ? 'bar' : type;
  });

  private readonly palette = computed(() => {
    const dark = this.theme() === 'dark';
    const style = this.isBrowser ? getComputedStyle(this.document.documentElement) : null;
    const read = (name: string) => style?.getPropertyValue(`--${name}`).trim() || FALLBACK[name];
    const colors: Record<ChartTone, string> = {
      acc: read('acc'),
      up: read('up'),
      down: read('down'),
      warn: read('warn'),
      mute: read('tx-3'),
      c1: read('acc'),
      c2: dark ? '#f08a24' : '#e07000',
      c3: dark ? '#22ab94' : '#089981',
      // The dark step is lifted: #9c27b0 sits under 3:1 on the dark surface.
      c4: dark ? '#c265d4' : '#9c27b0',
    };
    return { colors, tx3: read('tx-3'), grid: read('line-soft'), surf: read('surf') };
  });

  protected readonly chartData = computed(() => {
    const { colors, surf } = this.palette();
    const type = this.type();

    if (type === 'doughnut') {
      const tones = this.tones();
      return {
        labels: this.labels(),
        datasets: this.series().map((s) => ({
          label: s.label,
          data: s.data,
          backgroundColor: s.data.map((_, i) => colors[tones[i] ?? CATEGORICAL[i] ?? 'mute']),
          borderColor: surf,
          borderWidth: 2,
          hoverOffset: 4,
        })),
      };
    }

    const line = type === 'line';
    return {
      labels: this.labels(),
      datasets: this.series().map((s) => {
        const color = colors[s.tone ?? 'acc'];
        return {
          label: s.label,
          data: s.data,
          backgroundColor: line ? withAlpha(color, 0.12) : color,
          borderColor: line ? color : surf,
          borderWidth: line ? 2 : { top: 0, right: 0, bottom: 0, left: 0 },
          borderRadius: line ? 0 : 4,
          borderSkipped: 'start',
          maxBarThickness: type === 'hbar' ? 18 : 26,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointBackgroundColor: color,
          tension: 0.3,
          fill: line && this.series().length === 1 ? 'origin' : false,
        };
      }),
    };
  });

  protected readonly chartOptions = computed(() => {
    const { tx3, grid } = this.palette();
    const format = this.format();
    const type = this.type();
    const multi = this.series().length > 1;
    const tick = { color: tx3, font: { size: 11 } };

    if (type === 'doughnut') {
      return {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx: { label: string; parsed: number }) => `${ctx.label}: ${format(ctx.parsed)}`,
            },
          },
        },
      };
    }

    const horizontal = type === 'hbar';
    const stacked = type === 'bar' && multi && this.stacked();
    const category = {
      stacked,
      grid: { display: false },
      border: { display: false },
      ticks: { ...tick, maxRotation: 0, autoSkipPadding: 12 },
    };
    const value = {
      stacked,
      beginAtZero: true,
      grid: { color: grid },
      border: { display: false },
      ticks: { ...tick, maxTicksLimit: 5, callback: (v: number) => format(v) },
    };

    return {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: multi,
          position: 'top',
          align: 'end',
          labels: { color: tx3, boxWidth: 8, boxHeight: 8, usePointStyle: true, font: { size: 11 } },
        },
        tooltip: {
          displayColors: multi,
          callbacks: {
            label: (ctx: { dataset: { label: string }; parsed: { x: number; y: number } }) =>
              `${ctx.dataset.label}: ${format(horizontal ? ctx.parsed.x : ctx.parsed.y)}`,
          },
        },
      },
      scales: horizontal ? { x: value, y: category } : { x: category, y: value },
    };
  });
}

/** "#2962ff" → "rgba(41, 98, 255, a)"; non-hex colours pass through unchanged. */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** "2026-09-20" → "20 Sep" for chart axes. */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}
