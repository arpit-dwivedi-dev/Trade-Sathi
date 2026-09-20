import { Component, inject } from '@angular/core';

import { ThemeService } from '../core/theme.service';
import { AppIcon } from './icons/app-icon';

/** The corner theme switch on the signed-out screens, pinned top-right.
    Bare icon, no chip or surface — it sits in the screen, not on top of it. */
@Component({
  selector: 'app-theme-toggle',
  imports: [AppIcon],
  template: `
    <button
      type="button"
      class="theme-toggle"
      (click)="themeService.toggle()"
      [attr.aria-label]="theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
      [attr.title]="theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
    >
      <app-icon aria-hidden="true" [name]="theme() === 'dark' ? 'light_mode' : 'dark_mode'" />
    </button>
  `,
  styles: `
    .theme-toggle {
      align-items: center;
      background: none;
      border: 0;
      border-radius: var(--r-pill);
      color: var(--tx-3);
      cursor: pointer;
      display: flex;
      font-size: 20px;
      height: 40px;
      justify-content: center;
      padding: 0;
      position: fixed;
      right: 24px;
      top: 21px;
      transition: color var(--dur-subtle) var(--ease-move);
      width: 40px;
      z-index: 50;
    }

    .theme-toggle:hover {
      color: var(--tx);
    }

    @media (max-width: 640px) {
      .theme-toggle {
        right: 16px;
        top: 16px;
      }
    }
  `,
})
export class ThemeToggle {
  protected readonly themeService = inject(ThemeService);
  protected readonly theme = this.themeService.theme;
}
