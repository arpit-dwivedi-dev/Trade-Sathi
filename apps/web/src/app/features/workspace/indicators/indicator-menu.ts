import { Component, input, output, signal } from '@angular/core';

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
  templateUrl: './indicator-menu.html',
  styleUrl: './indicator-menu.css',
})
export class IndicatorMenu {
  protected readonly options = INDICATOR_OPTIONS;
  protected readonly open = signal(false);

  readonly active = input<ReadonlySet<IndicatorKind>>(new Set());
  readonly activeChange = output<ReadonlySet<IndicatorKind>>();

  protected toggleMenu(): void {
    this.open.update((v) => !v);
  }

  protected closeMenu(): void {
    this.open.set(false);
  }

  protected isActive(kind: IndicatorKind): boolean {
    return this.active().has(kind);
  }

  protected toggle(kind: IndicatorKind): void {
    const next = new Set(this.active());
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    this.activeChange.emit(next);
  }
}
