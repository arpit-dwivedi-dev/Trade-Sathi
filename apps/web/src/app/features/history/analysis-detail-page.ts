import { DatePipe, Location, isPlatformBrowser } from '@angular/common';
import { Component, DestroyRef, PLATFORM_ID, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { ThemeService } from '../../core/theme.service';
import { ChartImage } from '../../shared/chart-image';
import { AppIcon } from '../../shared/icons/app-icon';
import { AnalysisResult } from '../analyze/analysis-result';
import { FundamentalsAnalysisResultComponent } from '../fundamentals/fundamentals-analysis-result';
import { AnalysisPdfService } from './analysis-pdf.service';
import {
  HistoryService,
  type HistoryDetail,
} from './history.service';

@Component({
  selector: 'app-analysis-detail-page',
  imports: [AnalysisResult, AppIcon, ButtonModule, ChartImage, DatePipe, FundamentalsAnalysisResultComponent, ProgressSpinnerModule, RouterLink],
  templateUrl: './analysis-detail-page.html',
  styleUrl: './analysis-detail-page.css',
})
export class AnalysisDetailPage {
  private readonly history = inject(HistoryService);
  private readonly pdf = inject(AnalysisPdfService);
  private readonly themeService = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);
  private requestToken = 0;

  protected readonly detail = signal<HistoryDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly theme = this.themeService.theme;
  protected readonly downloadBusy = signal(false);
  protected readonly downloadError = signal<string | null>(null);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id');
      if (!isPlatformBrowser(this.platformId)) return;
      void this.load(id);
    });
  }

  /**
   * The report opens in the same tab now, so "back" should land the user
   * exactly where they left off — the history list at its old scroll offset,
   * or the analyze page they just ran. Only when this page was entered
   * directly (deep link, refresh, restored tab) is there nothing to step back
   * to, and then history is the sensible home.
   */
  protected goBack(): void {
    if (this.router.lastSuccessfulNavigation()?.previousNavigation) {
      this.location.back();
      return;
    }
    void this.router.navigate(['/app/history']);
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected async retry(): Promise<void> {
    await this.load(this.route.snapshot.paramMap.get('id'));
  }

  protected async download(): Promise<void> {
    const loaded = this.detail();
    if (!loaded || this.downloadBusy()) return;

    this.downloadBusy.set(true);
    this.downloadError.set(null);
    try {
      await this.pdf.download(loaded.row, loaded.patterns);
    } catch (cause) {
      console.warn('analysis PDF export failed', cause);
      this.downloadError.set("We couldn't create the PDF. Please try again.");
    } finally {
      this.downloadBusy.set(false);
    }
  }

  private async load(id: string | null): Promise<void> {
    const token = ++this.requestToken;
    this.detail.set(null);
    this.error.set(null);
    this.downloadError.set(null);

    if (!id) {
      this.error.set("We couldn't find that analysis.");
      return;
    }

    this.loading.set(true);
    try {
      const detail = await this.history.fetchDetail(id);
      if (token !== this.requestToken) return;
      this.detail.set(detail);
    } catch (cause) {
      console.warn('analysis detail fetch failed', cause);
      if (token !== this.requestToken) return;
      this.error.set("We couldn't load this analysis. It may no longer be available.");
    } finally {
      if (token === this.requestToken) this.loading.set(false);
    }
  }
}
