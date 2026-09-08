import { DatePipe, isPlatformBrowser } from '@angular/common';
import { Component, DestroyRef, PLATFORM_ID, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { AppIcon } from '../../shared/icons/app-icon';
import { ChartImage } from '../../shared/chart-image';
import { AnalysisResult } from '../analyze/analysis-result';
import { FundamentalsAnalysisResultComponent } from '../fundamentals/fundamentals-analysis-result';
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
  private readonly route = inject(ActivatedRoute);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);
  private requestToken = 0;

  protected readonly detail = signal<HistoryDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id');
      if (!isPlatformBrowser(this.platformId)) return;
      void this.load(id);
    });
  }

  protected async retry(): Promise<void> {
    await this.load(this.route.snapshot.paramMap.get('id'));
  }

  private async load(id: string | null): Promise<void> {
    const token = ++this.requestToken;
    this.detail.set(null);
    this.error.set(null);

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
