import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tradesathi.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Owns the active theme and mirrors it onto <html data-theme="...">.
 *
 * With nothing stored, the theme follows the OS/browser setting and tracks it
 * live. Toggling stores an explicit choice; toggling back to whatever the OS
 * currently wants clears it, so the user returns to following the system.
 * The inline script in index.html applies the same rule before first paint.
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

    if (this.isBrowser) {
      window.matchMedia(DARK_QUERY).addEventListener('change', () => {
        if (this.stored() === null) {
          this.current.set(this.system());
          this.apply(this.current());
        }
      });
    }
  }

  set(theme: Theme): void {
    this.current.set(theme);
    this.apply(theme);

    if (this.isBrowser) {
      try {
        if (theme === this.system()) {
          localStorage.removeItem(STORAGE_KEY);
        } else {
          localStorage.setItem(STORAGE_KEY, theme);
        }
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

    return this.stored() ?? this.system();
  }

  private stored(): Theme | null {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
    } catch {
      // fall through to the system setting
    }
    return null;
  }

  private system(): Theme {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  }

  private apply(theme: Theme): void {
    this.document.documentElement.setAttribute('data-theme', theme);
  }
}
