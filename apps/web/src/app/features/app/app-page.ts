import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AnalyzePage } from '../analyze/analyze-page';
import { HistoryList } from '../history/history-list';
import { AuthService } from '../../core/auth.service';

type Tab = 'analyze' | 'history';

@Component({
  selector: 'app-app-page',
  imports: [AnalyzePage, HistoryList],
  templateUrl: './app-page.html',
})
export class AppPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly user = this.auth.user;
  protected readonly tab = signal<Tab>('analyze');

  protected select(tab: Tab): void {
    this.tab.set(tab);
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
