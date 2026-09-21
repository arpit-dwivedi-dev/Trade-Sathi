import { Component, computed, input } from '@angular/core';

import { AdminChart, CATEGORICAL, type ChartTone } from './admin-chart';

export interface DonutSlice {
  label: string;
  value: number;
  /** Defaults to the categorical order by position. */
  tone?: ChartTone;
}

/**
 * A doughnut with its total in the hole and a legend that carries each slice's
 * value and share in text — the colour is never the only way to read a slice.
 */
@Component({
  selector: 'app-admin-donut',
  imports: [AdminChart],
  template: `
    @if (total() > 0) {
      <div class="donut">
        <div class="donut-ring">
          <app-admin-chart type="doughnut" [height]="168" [labels]="labels()"
                           [series]="series()" [tones]="tones()" [format]="format()" />
          <div class="donut-center" aria-hidden="true">
            <b class="tnum">{{ format()(total()) }}</b>
            <span class="lbl">{{ centerLabel() }}</span>
          </div>
        </div>
        <ul class="donut-legend">
          @for (s of rows(); track s.label) {
            <li>
              <i class="donut-dot" [attr.data-tone]="s.tone"></i>
              <span class="donut-name">{{ s.label }}</span>
              <span class="tnum donut-val">{{ format()(s.value) }}</span>
              <span class="tnum donut-share">{{ s.share }}%</span>
            </li>
          }
        </ul>
      </div>
    } @else {
      <p class="meta dim donut-empty">{{ emptyText() }}</p>
    }
  `,
  styles: `
    /* Ring above, legend below at the card's full width. Side by side, the
       legend got what was left beside a 168px ring and every label was
       truncated in the narrower cards. */
    .donut {
      align-items: center;
      display: flex;
      flex-direction: column;
      gap: var(--s4);
    }

    .donut-ring {
      flex: none;
      height: 168px;
      overflow: hidden;
      position: relative;
      width: 168px;
    }

    .donut-center {
      align-items: center;
      display: flex;
      flex-direction: column;
      inset: 0;
      justify-content: center;
      pointer-events: none;
      position: absolute;
    }

    .donut-center b {
      color: var(--tx);
      font-size: var(--t-lg);
      font-weight: 600;
      letter-spacing: -0.015em;
      line-height: 1.2;
    }

    .donut-center .lbl {
      font-size: var(--t-3xs);
    }

    .donut-legend {
      display: flex;
      flex-direction: column;
      gap: var(--s2);
      list-style: none;
      margin: 0;
      max-width: 360px;
      min-width: 0;
      padding: 0;
      width: 100%;
    }

    .donut-legend li {
      align-items: center;
      display: grid;
      font-size: var(--t-xs);
      gap: var(--s2);
      grid-template-columns: 8px minmax(0, 1fr) auto 40px;
    }

    .donut-dot {
      border-radius: 2px;
      height: 8px;
      width: 8px;
    }

    .donut-name {
      color: var(--tx-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .donut-val {
      color: var(--tx);
      font-weight: 600;
    }

    .donut-share {
      color: var(--tx-3);
      text-align: right;
    }

    [data-tone='acc'], [data-tone='c1'] { background: var(--acc); }
    [data-tone='up'] { background: var(--up); }
    [data-tone='down'] { background: var(--down); }
    [data-tone='warn'] { background: var(--warn); }
    [data-tone='mute'] { background: var(--tx-3); }
    [data-tone='c2'] { background: #e07000; }
    [data-tone='c3'] { background: #089981; }
    [data-tone='c4'] { background: #9c27b0; }
    :host-context([data-theme='dark']) [data-tone='c2'] { background: #f08a24; }
    :host-context([data-theme='dark']) [data-tone='c3'] { background: #22ab94; }
    :host-context([data-theme='dark']) [data-tone='c4'] { background: #c265d4; }

    .donut-empty {
      margin: 0;
      padding: var(--s6) 0;
      text-align: center;
    }
  `,
})
export class AdminDonut {
  readonly slices = input.required<DonutSlice[]>();
  readonly centerLabel = input('Total');
  readonly emptyText = input('Nothing in this period.');
  readonly format = input<(value: number) => string>((value) => value.toLocaleString());

  /** Zero slices are dropped: they draw nothing and only crowd the legend. */
  protected readonly rows = computed(() => {
    const slices = this.slices().filter((s) => s.value > 0);
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    return slices.map((s, i) => ({
      ...s,
      tone: s.tone ?? CATEGORICAL[i] ?? 'mute',
      share: total ? Math.round((s.value / total) * 100) : 0,
    }));
  });

  protected readonly total = computed(() => this.rows().reduce((sum, s) => sum + s.value, 0));
  protected readonly labels = computed(() => this.rows().map((s) => s.label));
  protected readonly tones = computed(() => this.rows().map((s) => s.tone));
  protected readonly series = computed(() => [{ label: this.centerLabel(), data: this.rows().map((s) => s.value) }]);
}
