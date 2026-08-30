import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'chartanalyzer.theme';

/**
 * Owns the active theme and mirrors it onto <html data-theme="...">.
 *
 * Browser-only, for the same reason as the Supabase client: localStorage does
 * not exist during SSR. On the server this resolves to light and never touches
 * storage or the DOM, so the server-rendered markup is deterministic.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly document = inject(DOCUMENT);

  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private readonly current = signal<Theme>(this.read());

  readonly theme = this.current.asReadonly();

  constructor() {
    this.apply(this.current());
  }

  set(theme: Theme): void {
    this.current.set(theme);
    this.apply(theme);

    if (this.isBrowser) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Private-mode or blocked storage: the theme still applies for this
        // session, it just will not be remembered.
      }
    }
  }

  toggle(): void {
    this.set(this.current() === 'dark' ? 'light' : 'dark');
  }

  private read(): Theme {
    if (!this.isBrowser) {
      return 'light';
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
    } catch {
      // fall through to the default
    }

    return 'light';
  }

  private apply(theme: Theme): void {
    this.document.documentElement.setAttribute('data-theme', theme);
  }
}
