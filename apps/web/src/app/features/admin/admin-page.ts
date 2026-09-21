import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SelectButtonModule } from 'primeng/selectbutton';
import type { AdminRange } from '@tradesathi/shared';

import { AppIcon } from '../../shared/icons/app-icon';
import type { IconName } from '../../shared/icons/icon-paths';

import { AdminActivitySection } from './sections/admin-activity';
import { AdminEconomicsSection } from './sections/admin-economics';
import { AdminHealthSection } from './sections/admin-health';
import { AdminOverviewSection } from './sections/admin-overview';
import { AdminPaymentsSection } from './sections/admin-payments';
import { AdminUsersSection } from './sections/admin-users';

export type AdminSection = 'overview' | 'economics' | 'payments' | 'users' | 'activity' | 'health';

const SECTIONS: readonly { id: AdminSection; label: string; icon: IconName; blurb: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard', blurb: 'Users, revenue and usage at a glance.' },
  { id: 'economics', label: 'Economics', icon: 'balance', blurb: 'Estimated revenue against AI cost, per analysis.' },
  { id: 'payments', label: 'Payments', icon: 'sell', blurb: 'Every checkout and what became of it.' },
  { id: 'users', label: 'Users', icon: 'person', blurb: 'Accounts, balances and spend. Select a row for detail.' },
  { id: 'activity', label: 'Activity', icon: 'monitoring', blurb: 'What people use the product for.' },
  { id: 'health', label: 'Health', icon: 'speed', blurb: 'Errors and stuck work, right now.' },
];

/** Sections whose figures depend on the date range; the rest ignore it. */
const RANGED: readonly AdminSection[] = ['overview', 'economics', 'payments', 'activity'];

function parseSection(value: string | null): AdminSection {
  return SECTIONS.some((s) => s.id === value) ? (value as AdminSection) : 'overview';
}

function parseRange(value: string | null): AdminRange {
  return value === '7d' || value === 'all' ? value : '30d';
}

/**
 * The read-only Admin panel, hosted as the shell's `admin` tab. The section
 * and date range live in the query string (`/app/admin?section=users&range=7d`)
 * so a reload or a shared link lands on the same view.
 *
 * Nothing here is a security boundary — adminGuard only hides the screen; the
 * API authorizes every request itself.
 */
@Component({
  selector: 'app-admin-page',
  imports: [
    FormsModule,
    AppIcon,
    SelectButtonModule,
    AdminActivitySection,
    AdminEconomicsSection,
    AdminHealthSection,
    AdminOverviewSection,
    AdminPaymentsSection,
    AdminUsersSection,
  ],
  templateUrl: './admin-page.html',
  styleUrl: './admin-page.css',
})
export class AdminPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly query = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  protected readonly sections = SECTIONS;
  protected readonly section = computed(() => parseSection(this.query().get('section')));
  protected readonly range = computed(() => parseRange(this.query().get('range')));
  protected readonly current = computed(() => SECTIONS.find((s) => s.id === this.section())!);
  protected readonly ranged = computed(() => RANGED.includes(this.section()));

  protected readonly ranges: { value: AdminRange; label: string }[] = [
    { value: '7d', label: '7D' },
    { value: '30d', label: '30D' },
    { value: 'all', label: 'All' },
  ];

  protected selectSection(value: AdminSection): void {
    this.navigate({ section: value });
  }

  /** Arrow keys move along the tab strip, per the WAI-ARIA tabs pattern. */
  protected onTabKey(event: KeyboardEvent, index: number): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = SECTIONS[(index + step + SECTIONS.length) % SECTIONS.length];
    this.selectSection(next.id);
    const strip = (event.currentTarget as HTMLElement).parentElement;
    strip?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
  }

  protected selectRange(value: AdminRange | null): void {
    if (value) this.navigate({ range: value });
  }

  private navigate(params: { section?: AdminSection; range?: AdminRange }): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: params,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}

