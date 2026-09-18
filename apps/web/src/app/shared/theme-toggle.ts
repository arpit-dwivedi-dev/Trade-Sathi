import { Component, inject } from '@angular/core';

import { ThemeService } from '../core/theme.service';
import { AppIcon } from './icons/app-icon';

/** The corner theme switch on the signed-out screens, pinned top-right. */
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
      background: var(--surf);
      border: 1px solid var(--line);
      border-radius: var(--r-pill);
      box-shadow: var(--sh-3);
      color: var(--tx-2);
      cursor: pointer;
      display: flex;
      font-size: 20px;
      height: 44px;
      justify-content: center;
      position: fixed;
      right: 24px;
      top: 21px;
      transition:
        background var(--dur-subtle) var(--ease-move),
        color var(--dur-subtle) var(--ease-move);
      width: 44px;
      z-index: 50;
    }

    .theme-toggle:hover {
      background: var(--surf-2);
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
