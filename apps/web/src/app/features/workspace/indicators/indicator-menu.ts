import { Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

/**
 * Every indicator KLineChart ships, identified by the library's own name so a
 * menu entry, a persisted selection and `createIndicator` are all one string.
 *
 * Periods are deliberately absent: the library's defaults are the
 * conventional ones (BOLL 20/2, MACD 12/26/9, KDJ 9/3/3), and the chart
 * prints the parameters it used in each indicator's own legend — so there is
 * nothing for the app to restate or keep in sync.
 *
 * VOL is not listed: the volume histogram is part of every chart this app
 * draws (see chart-render's createCandleChart), not something to switch on.
 */
export type IndicatorKind =
  | 'MA'
  | 'EMA'
  | 'SMA'
  | 'BOLL'
  | 'BBI'
  | 'SAR'
  | 'AVP'
  | 'MACD'
  | 'RSI'
  | 'KDJ'
  | 'CCI'
  | 'WR'
  | 'DMI'
  | 'DMA'
  | 'TRIX'
  | 'MTM'
  | 'ROC'
  | 'BIAS'
  | 'PSY'
  | 'BRAR'
  | 'CR'
  | 'AO'
  | 'OBV'
  | 'PVT'
  | 'VR'
  | 'EMV';

export interface IndicatorOption {
  kind: IndicatorKind;
  label: string;
  /** 'overlay' shares the price pane and its scale; 'sub' gets its own pane below. */
  pane: 'overlay' | 'sub';
  /** Material Symbols glyph name — what the row's glyph tile draws. */
  icon: string;
}

/** Grouped the way the menu renders them — overlays first, then the panels. */
export const INDICATOR_OPTIONS: readonly IndicatorOption[] = [
  { kind: 'MA', label: 'Moving Average', pane: 'overlay', icon: 'show_chart' },
  { kind: 'EMA', label: 'Exponential Moving Average', pane: 'overlay', icon: 'ssid_chart' },
  { kind: 'SMA', label: 'Smoothed Moving Average', pane: 'overlay', icon: 'timeline' },
  { kind: 'BOLL', label: 'Bollinger Bands', pane: 'overlay', icon: 'expand' },
  { kind: 'BBI', label: 'Bull & Bear Index', pane: 'overlay', icon: 'layers' },
  { kind: 'SAR', label: 'Parabolic SAR', pane: 'overlay', icon: 'scatter_plot' },
  { kind: 'AVP', label: 'Average Price', pane: 'overlay', icon: 'horizontal_rule' },

  { kind: 'MACD', label: 'MACD', pane: 'sub', icon: 'bar_chart' },
  { kind: 'RSI', label: 'Relative Strength Index', pane: 'sub', icon: 'speed' },
  { kind: 'KDJ', label: 'KDJ Stochastic', pane: 'sub', icon: 'multiline_chart' },
  { kind: 'CCI', label: 'Commodity Channel Index', pane: 'sub', icon: 'compare_arrows' },
  { kind: 'WR', label: 'Williams %R', pane: 'sub', icon: 'trending_down' },
  { kind: 'DMI', label: 'Directional Movement (DMI)', pane: 'sub', icon: 'call_split' },
  { kind: 'DMA', label: 'Difference of Moving Average', pane: 'sub', icon: 'difference' },
  { kind: 'TRIX', label: 'TRIX', pane: 'sub', icon: 'waterfall_chart' },
  { kind: 'MTM', label: 'Momentum', pane: 'sub', icon: 'bolt' },
  { kind: 'ROC', label: 'Rate of Change', pane: 'sub', icon: 'percent' },
  { kind: 'BIAS', label: 'BIAS', pane: 'sub', icon: 'balance' },
  { kind: 'PSY', label: 'Psychological Line', pane: 'sub', icon: 'psychology' },
  { kind: 'BRAR', label: 'BRAR Sentiment', pane: 'sub', icon: 'sentiment_satisfied' },
  { kind: 'CR', label: 'CR Energy', pane: 'sub', icon: 'local_fire_department' },
  { kind: 'AO', label: 'Awesome Oscillator', pane: 'sub', icon: 'graphic_eq' },
  { kind: 'OBV', label: 'On-Balance Volume', pane: 'sub', icon: 'equalizer' },
  { kind: 'PVT', label: 'Price Volume Trend', pane: 'sub', icon: 'stacked_bar_chart' },
  { kind: 'VR', label: 'Volume Ratio', pane: 'sub', icon: 'pie_chart' },
  { kind: 'EMV', label: 'Ease of Movement', pane: 'sub', icon: 'moving' },
];

export const INDICATOR_KINDS = INDICATOR_OPTIONS.map((option) => option.kind);

const KIND_SET = new Set<string>(INDICATOR_KINDS);

export function isIndicatorKind(value: unknown): value is IndicatorKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

export function indicatorPane(kind: IndicatorKind): 'overlay' | 'sub' {
  return INDICATOR_OPTIONS.find((option) => option.kind === kind)?.pane ?? 'sub';
}

@Component({
  selector: 'app-indicator-menu',
  imports: [MatIconModule, MatMenuModule],
  templateUrl: './indicator-menu.html',
  styleUrl: './indicator-menu.css',
})
export class IndicatorMenu {
  protected readonly overlays = INDICATOR_OPTIONS.filter((option) => option.pane === 'overlay');
  protected readonly panels = INDICATOR_OPTIONS.filter((option) => option.pane === 'sub');
  /** Denominator of the panel's "n of m active" line. */
  protected readonly total = INDICATOR_OPTIONS.length;

  readonly active = input<ReadonlySet<IndicatorKind>>(new Set());
  readonly activeChange = output<ReadonlySet<IndicatorKind>>();

  protected isActive(kind: IndicatorKind): boolean {
    return this.active().has(kind);
  }

  /**
   * Stopping propagation keeps the menu open across a toggle — this is a
   * multi-select checklist, not a list of one-shot actions, so a click
   * shouldn't dismiss it the way selecting a normal mat-menu-item does.
   */
  protected toggle(event: MouseEvent, kind: IndicatorKind): void {
    event.stopPropagation();
    const next = new Set(this.active());
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    this.activeChange.emit(next);
  }

  protected clear(event: MouseEvent): void {
    event.stopPropagation();
    this.activeChange.emit(new Set());
  }
}
