import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AnalyzePage } from '../analyze/analyze-page';
import { HistoryList } from '../history/history-list';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

type Tab = 'analyze' | 'history';

@Component({
  selector: 'app-app-page',
  imports: [AnalyzePage, HistoryList, RouterLink],
  styleUrl: './app-page.css',
  templateUrl: './app-page.html',
})
export class AppPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);

  protected readonly user = this.auth.user;
  protected readonly tab = signal<Tab>('analyze');
  protected readonly theme = this.themeService.theme;

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected select(tab: Tab): void {
    this.tab.set(tab);
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
