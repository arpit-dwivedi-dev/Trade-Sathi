import { Injectable, signal } from '@angular/core';

export type PnlCurrency = 'INR' | 'USD';

const STORAGE_KEY = 'tradesathi.admin.pnlCurrency';

/**
 * Which currency the Admin panel shows P&L in. Shared so the Overview and
 * Economics tabs agree, and remembered per browser — a viewer preference,
 * so localStorage is the right home and losing it only resets to ₹.
 */
@Injectable({ providedIn: 'root' })
export class AdminCurrencyService {
  private readonly state = signal<PnlCurrency>(read());
  readonly currency = this.state.asReadonly();

  toggle(): void {
    const next: PnlCurrency = this.state() === 'INR' ? 'USD' : 'INR';
    this.state.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice just won't survive a reload.
    }
  }
}

function read(): PnlCurrency {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'USD' ? 'USD' : 'INR';
  } catch {
    return 'INR';
  }
}
