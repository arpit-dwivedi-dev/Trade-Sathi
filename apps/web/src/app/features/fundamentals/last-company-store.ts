/**
 * localStorage-backed record of the company the Fundamentals tab was last
 * showing.
 *
 * The instrument is picked in the shell's top-bar search and handed down as an
 * input, so nothing about it survives a page load on its own — refreshing the
 * tab dropped the user back to an empty screen and made them search the symbol
 * again. Remembering it here restores the company they were reading.
 *
 * Per-browser convenience, same as the workspace's last-chart-store.ts:
 * nothing goes to the API.
 */
const STORAGE_KEY = 'fundamentals:last-company:v1';

export interface LastCompany {
  instrument: { id: string; symbol: string; name: string; exchange: string; logoUrl?: string };
}

export function saveLastCompany(isBrowser: boolean, company: LastCompany): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(company));
  } catch {
    // Storage full or unavailable (private browsing) — the tab simply opens
    // empty next time, which is how it behaved before this existed.
  }
}

/** Returns the remembered company, or null if there is none or it is unreadable. */
export function loadLastCompany(isBrowser: boolean): LastCompany | null {
  if (!isBrowser) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<LastCompany> | null;
    const instrument = parsed?.instrument;
    if (
      !instrument ||
      typeof instrument.id !== 'string' ||
      typeof instrument.symbol !== 'string' ||
      typeof instrument.name !== 'string' ||
      typeof instrument.exchange !== 'string'
    ) {
      return null;
    }
    return { instrument };
  } catch {
    return null;
  }
}
