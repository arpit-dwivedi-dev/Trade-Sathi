import { Component, DestroyRef, OnInit, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AnalyzePage } from '../analyze/analyze-page';
import { BillingService } from '../billing/billing.service';
import { PlansOverlay } from '../billing/plans-overlay';
import { HistoryList } from '../history/history-list';
import { Watchlist } from '../watchlist/watchlist';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

type Tab = 'analyze' | 'history' | 'watchlist';

const TABS: readonly Tab[] = ['analyze', 'history', 'watchlist'];

function parseTab(value: string | null): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : 'analyze';
}

@Component({
  selector: 'app-app-page',
  imports: [AnalyzePage, HistoryList, PlansOverlay, RouterLink, Watchlist],
  styleUrl: './app-page.css',
  templateUrl: './app-page.html',
})
export class AppPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly user = this.auth.user;
  protected readonly tab = signal<Tab>('analyze');
  protected readonly theme = this.themeService.theme;
  protected readonly plansOpen = signal(false);
  /** The shared cached read; the overlay and the picker use this same value. */
  protected readonly currentPlanKey = this.billing.currentPlanKey;

  /**
   * AnalyzePage stays mounted for the life of the shell (it is hidden, not
   * destroyed, on the History tab), so this reference is stable. It is how a
   * purchase made in the overlay reaches the page's reset — including a
   * purchase started from the nav while the page sits in quota_exceeded, which
   * an output wired only to the quota block would miss.
   */
  private readonly analyzePage = viewChild(AnalyzePage);

  ngOnInit(): void {
    // The tab lives in the URL so links from outside the shell — the Account
    // page's nav, a bookmark — can land on a specific tab. Subscribed rather
    // than read once: navigating to /app?tab=… while already here reuses this
    // component instance, so only the param stream reports the change.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.tab.set(parseTab(params.get('tab')));
    });

    // The one plan read for the whole shell. Everything downstream — this
    // control's label, the overlay, the plan picker's "Current plan" marker —
    // reads the cache it fills rather than querying again.
    void this.billing.ensurePlanSummary();
  }

  /**
   * A free user is offered the upgrade; a paid user is offered credits, since
   * moving between paid tiers is not built. An unknown plan (the read failed)
   * falls back to the credits label, which is valid on every tier.
   */
  protected billingLabel(): string {
    return this.currentPlanKey() === 'free' ? 'Upgrade' : 'Buy Credits';
  }

  protected openPlans(): void {
    this.plansOpen.set(true);
  }

  protected closePlans(): void {
    this.plansOpen.set(false);
  }

  protected onUpgraded(): void {
    this.analyzePage()?.onUpgraded();
  }

  protected onCreditsAdded(): void {
    this.analyzePage()?.onCreditsAdded();
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  /**
   * Writes the tab to the URL; the queryParamMap subscription above is what
   * actually flips the signal, so in-shell clicks and external links take the
   * identical path. replaceUrl keeps tab switching out of the back stack.
   */
  protected select(tab: Tab): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      replaceUrl: true,
    });
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
