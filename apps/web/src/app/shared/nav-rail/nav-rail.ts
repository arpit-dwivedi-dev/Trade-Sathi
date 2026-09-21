import { Component, computed, inject, input, model, output } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { Router, RouterLink } from '@angular/router';

import { AdminAccessService } from '../../core/admin-access.service';
import { AuthService } from '../../core/auth.service';
import { BillingService } from '../../features/billing/billing.service';
import { ProfileService } from '../../features/account/profile.service';
import { ThemeService } from '../../core/theme.service';
import { AppIcon } from '../icons/app-icon';
import { TAB_LABELS, type NavTab } from './nav-tabs';

/**
 * The signed-in nav rail. Every destination is a tab of the app shell, reached
 * by writing `/app/<tab>`; the shell picks its tab up from the URL, so
 * navigating is all this has to do.
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
  private readonly themeService = inject(ThemeService);
  private readonly adminAccess = inject(AdminAccessService);

  /** Shows the Admin row. Display only — the admin API authorizes itself. */
  protected readonly isAdmin = this.adminAccess.isAdmin;

  protected readonly theme = this.themeService.theme;

  /** The row to mark as the current screen. */
  readonly active = input.required<NavTab>();

  /**
   * What each row is called, from nav-tabs.ts rather than written into the
   * template — the same string is the row's label, its tooltip, and the title
   * the shell prints in the top bar. Written out in both places it drifted.
   */
  protected readonly labels = TAB_LABELS;

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

  constructor() {
    // One profile read for the whole session, shared with the Account page.
    void this.profiles.ensureName();

    // The rail no longer prints the balance, but it is still the first thing
    // mounted inside the shell, so warming the cache here means the Billing tab
    // has the figure already when the Buy Credits button lands on it.
    // ensureCreditBalance is cached on the root service, so this shares
    // whatever the shell already fetched rather than adding a request.
    void this.billing.ensureCreditBalance();

    void this.adminAccess.ensure();
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected async signOut(): Promise<void> {
    this.activated.emit();
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
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
    void this.router.navigate(['/app', tab], {
      replaceUrl: this.router.url.startsWith('/app'),
    });
  }
}
