import { Component, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ChipModule } from 'primeng/chip';
import { RouterLink } from '@angular/router';

import { AppIcon } from '../../shared/icons/app-icon';
import { ThemeService } from '../../core/theme.service';

/**
 * Public marketing page — the only route reachable without a session.
 * Purely static: it describes what the product returns and links into auth.
 */
@Component({
  selector: 'app-landing-page',
  imports: [RouterLink, AppIcon, ButtonModule, CardModule, ChipModule],
  styleUrl: './landing-page.css',
  templateUrl: './landing-page.html',
})
export class LandingPage {
  private readonly themeService = inject(ThemeService);

  protected readonly theme = this.themeService.theme;

  protected toggleTheme(): void {
    this.themeService.toggle();
  }
}
