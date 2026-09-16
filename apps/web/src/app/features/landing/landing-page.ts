import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PricingOverview } from '@chartanalyzer/shared';

import { SupabaseClientService } from '../../core/supabase-client';
import { ThemeService } from '../../core/theme.service';
import { AppIcon } from '../../shared/icons/app-icon';
import { formatPriceMinor } from '../billing/billing.service';

/**
 * Public marketing page — the only route reachable without a session.
 *
 * The pricing section is the one dynamic piece: it reads GET /api/pricing so a
 * visitor sees real, region-correct prices (₹ vs $) before signing up. The
 * fetch is browser-only — a relative /api URL has no origin to resolve against
 * during SSR — so the server-rendered page shows the loading note and the
 * browser fills the numbers in on hydration.
 */
@Component({
  selector: 'app-landing-page',
  imports: [RouterLink, AppIcon, ButtonModule],
  styleUrl: './landing-page.css',
  templateUrl: './landing-page.html',
})
export class LandingPage implements OnInit {
  private readonly themeService = inject(ThemeService);
  private readonly http = inject(HttpClient);
  private readonly supabase = inject(SupabaseClientService);

  protected readonly theme = this.themeService.theme;

  /** Null until the browser-side fetch lands; the template degrades to a note. */
  protected readonly pricing = signal<PricingOverview | null>(null);

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  ngOnInit(): void {
    if (!this.supabase.isBrowser) return;
    // Fire-and-forget: the page renders fine without prices, so a slow or
    // failed request must not surface as an error to a logged-out visitor.
    firstValueFrom(this.http.get<PricingOverview>('/api/pricing'))
      .then((overview) => this.pricing.set(overview))
      .catch(() => undefined);
  }

  /** Integer minor units + currency → "₹49" / "$5", via the shared formatter. */
  protected priceLabel(amountMinor: number, currency: string): string {
    return formatPriceMinor(amountMinor, currency);
  }
}
