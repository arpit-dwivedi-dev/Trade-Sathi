import { Component, computed, inject, input, model, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { Router, RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { BillingService } from '../../features/billing/billing.service';
import { ProfileService } from '../../features/account/profile.service';
import { AppIcon } from '../icons/app-icon';

/** The dashboard tabs the rail links to. The app shell reads its own tab from the URL. */
export type NavTab =
  | 'analyze'
  | 'workspace'
  | 'history'
  | 'dailyBriefing'
  | 'fundamentals'
  | 'logs'
  | 'billing'
  | 'account';

/**
 * The signed-in nav rail. Every destination is a tab of the app shell,
 * reached by writing `/app?tab=…`; the shell picks its tab up from the URL,
 * so navigating is all this has to do.
 */
@Component({
  selector: 'app-nav-rail',
  imports: [ButtonModule, AppIcon, RouterLink],
  host: {
    class: 'nav',
    role: 'navigation',
    'aria-label': 'Sections',
  },
  templateUrl: './nav-rail.html',
})
export class NavRail {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly profiles = inject(ProfileService);

  /** The row to mark as the current screen. */
  readonly active = input.required<NavTab>();

  /**
   * Desktop-only icons-only state. A model rather than internal state because
   * the width it changes is a grid track on the parent `.shell`, so the parent
   * has to carry the matching class.
   */
  readonly collapsed = model(false);

  /** Fired on every row activation, so the parent can close the mobile drawer. */
  readonly activated = output<void>();

  protected readonly user = this.auth.user;

  /**
   * The profile name when there is one; the email address only as a fallback
   * for a profile with no name saved yet. Read straight off the profile
   * service rather than taken as an input: the rail is hosted by two
   * different pages, and when each had to pass the name down, whichever page
   * had not loaded it yet rendered the email instead.
   */
  protected readonly name = computed(
    () => this.profiles.cachedName()?.trim() || this.user()?.email || 'Account',
  );

  private readonly planKey = signal<string | null>(null);

  constructor() {
    // One profile read for the whole session, shared with the Account page.
    void this.profiles.ensureName();

    // The label below is the only thing this needs the plan for. ensurePlanSummary
    // is cached on the root service, so this shares whatever the billing screen
    // already fetched rather than adding a request.
    void this.billing.ensurePlanSummary().then(() => this.planKey.set(this.billing.currentPlanKey()));
  }

  /**
   * A free user is offered the upgrade; a paid user is offered credits, since
   * moving between paid tiers is not built. An unknown plan (the read failed)
   * gets the upgrade too — it is the safe default for a signed-in user.
   */
  protected billingLabel(): string {
    return this.planKey() === 'free' || this.planKey() === null ? 'Upgrade' : 'Buy Credits';
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((collapsed) => !collapsed);
  }

  /**
   * replaceUrl only while already in the shell: there, switching tabs is not a
   * step worth a back-stack entry. Arriving from outside it (a /login redirect,
   * a bookmark) is, or Back would skip straight past it.
   */
  protected select(tab: NavTab): void {
    this.activated.emit();
    void this.router.navigate(['/app'], {
      queryParams: { tab },
      replaceUrl: this.router.url.startsWith('/app'),
    });
  }
}
