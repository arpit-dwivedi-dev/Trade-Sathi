import { Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

/**
 * The fixed indicator set the workspace offers, each with its standard
 * default period(s) — no per-indicator settings UI (see the workspace plan's
 * deliberate scope cuts). SMA/EMA/Bollinger overlay on the price pane; RSI
 * and MACD each get their own sub-pane below it.
 */
export type IndicatorKind = 'sma' | 'ema' | 'bollinger' | 'rsi' | 'macd';

export interface IndicatorOption {
  kind: IndicatorKind;
  label: string;
  pane: 'overlay' | 'sub';
}

export const INDICATOR_OPTIONS: readonly IndicatorOption[] = [
  { kind: 'sma', label: 'SMA (20)', pane: 'overlay' },
  { kind: 'ema', label: 'EMA (21)', pane: 'overlay' },
  { kind: 'bollinger', label: 'Bollinger Bands (20, 2)', pane: 'overlay' },
  { kind: 'rsi', label: 'RSI (14)', pane: 'sub' },
  { kind: 'macd', label: 'MACD (12, 26, 9)', pane: 'sub' },
];

@Component({
  selector: 'app-indicator-menu',
  imports: [MatIconModule, MatMenuModule],
  templateUrl: './indicator-menu.html',
  styleUrl: './indicator-menu.css',
})
export class IndicatorMenu {
  protected readonly options = INDICATOR_OPTIONS;

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
}
