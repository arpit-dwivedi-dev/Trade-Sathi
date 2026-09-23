import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { PaginatorModule, type PaginatorState } from 'primeng/paginator';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import type { AdminPage, AdminPromoCodeCreated, AdminPromoCodeRow } from '@tradesathi/shared';

import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import { date } from '../admin-format';

const PAGE_SIZE = 25;
const COPIED_MS = 1500;

/** Who may redeem a new code: anyone holding it, or one email address. */
type Audience = 'everyone' | 'one';

type PromoStatus = 'Active' | 'Off' | 'Expired' | 'Used up';

/** Today as YYYY-MM-DD in local time: the earliest expiry the date field offers. */
function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * A date field's YYYY-MM-DD as the last second of that day, local time, so a
 * code set to expire "on the 30th" still works all of the 30th. (A date-time
 * string with no offset parses as local time.)
 */
function endOfLocalDay(day: string): string {
  return new Date(`${day}T23:59:59`).toISOString();
}

/**
 * Promo codes: create free-credit codes, for everyone or for one email address,
 * and switch existing ones on and off. A code is switched off rather than
 * deleted, so its redemptions and ledger entries keep pointing at something.
 */
@Component({
  selector: 'app-admin-promo-codes',
  imports: [
    ButtonModule,
    FormsModule,
    InputTextModule,
    MessageModule,
    PaginatorModule,
    ProgressSpinnerModule,
    SelectButtonModule,
    TableModule,
    ToggleSwitchModule,
  ],
  templateUrl: './admin-promo-codes.html',
  styleUrls: ['../admin-section.css', './admin-promo-codes.css'],
})
export class AdminPromoCodesSection {
  private readonly api = inject(AdminApiService);

  protected readonly audiences: { value: Audience; label: string }[] = [
    { value: 'everyone', label: 'Everyone' },
    { value: 'one', label: 'One person' },
  ];

  /* ── the create form ── */
  protected readonly audience = signal<Audience>('everyone');
  protected readonly email = signal('');
  protected readonly code = signal('');
  protected readonly credits = signal<number | null>(5);
  protected readonly maxRedemptions = signal<number | null>(null);
  protected readonly perUserLimit = signal<number | null>(1);
  protected readonly expires = signal('');
  protected readonly today = localToday();

  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly created = signal<AdminPromoCodeCreated | null>(null);
  /** The code last copied, so its button can say so for a moment. */
  protected readonly copied = signal<string | null>(null);

  /* ── the list ── */
  protected readonly first = signal(0);
  protected readonly pageSize = PAGE_SIZE;
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminPage<AdminPromoCodeRow> | null>(null);
  /** Ids with an on/off change in flight. */
  protected readonly saving = signal<ReadonlySet<string>>(new Set());

  protected readonly date = date;

  private seq = 0;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.load();
    inject(DestroyRef).onDestroy(() => {
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
    });
  }

  protected async create(): Promise<void> {
    if (this.creating()) return;
    const forOne = this.audience() === 'one';
    if (forOne && !this.email().trim()) {
      this.createError.set('Enter the email address this code is for.');
      return;
    }

    this.creating.set(true);
    this.createError.set(null);
    try {
      const created = await this.api.createPromoCode({
        code: this.code().trim() || null,
        credits: this.credits() ?? 0,
        email: forOne ? this.email().trim() : null,
        // A personal code is capped by its per-account limit alone.
        maxRedemptions: forOne ? null : this.maxRedemptions(),
        perUserLimit: this.perUserLimit() ?? 1,
        expiresAt: this.expires() ? endOfLocalDay(this.expires()) : null,
      });
      this.created.set(created);
      this.code.set('');
      this.email.set('');
      // Newest first, so the first page is where the new code shows up.
      this.first.set(0);
      void this.load();
    } catch (cause) {
      this.createError.set(adminErrorMessage(cause));
    } finally {
      this.creating.set(false);
    }
  }

  protected async copy(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Refused (permissions, or not a secure context). The code is on screen
      // to copy by hand, so there is nothing worth reporting.
      return;
    }
    this.copied.set(code);
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.copied.set(null), COPIED_MS);
  }

  /** Switches a code on or off. Off answers every redemption as an unknown code. */
  protected async toggleActive(row: AdminPromoCodeRow): Promise<void> {
    if (this.saving().has(row.id)) return;
    const active = !row.isActive;
    this.saving.update((s) => new Set(s).add(row.id));
    this.error.set(null);
    try {
      await this.api.setPromoCodeActive(row.id, active);
      this.data.update((d) =>
        d ? { ...d, rows: d.rows.map((r) => (r.id === row.id ? { ...r, isActive: active } : r)) } : d,
      );
    } catch (cause) {
      this.error.set(adminErrorMessage(cause));
    } finally {
      this.saving.update((s) => {
        const next = new Set(s);
        next.delete(row.id);
        return next;
      });
    }
  }

  protected status(row: AdminPromoCodeRow): PromoStatus {
    if (!row.isActive) return 'Off';
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return 'Expired';
    if (row.maxRedemptions !== null && row.redemptionCount >= row.maxRedemptions) return 'Used up';
    return 'Active';
  }

  protected statusClass(row: AdminPromoCodeRow): string {
    switch (this.status(row)) {
      case 'Active':
        return 'st st-complete';
      case 'Used up':
        return 'st st-processing';
      case 'Expired':
        return 'st st-failed';
      default:
        return 'st st-queued';
    }
  }

  /** One line describing a code, for the confirmation under the form. */
  protected summary(row: AdminPromoCodeRow): string {
    const credits = row.freeCredits ?? 0;
    return [
      `${credits} credit${credits === 1 ? '' : 's'} per use`,
      row.restrictedEmail
        ? `only for ${row.restrictedEmail}`
        : row.maxRedemptions !== null
          ? `${row.maxRedemptions} uses in total`
          : 'no total limit',
      `${row.perUserLimit} per account`,
      row.expiresAt ? `expires ${date(row.expiresAt)}` : 'no expiry',
    ].join(' · ');
  }

  protected onPage(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    void this.load();
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.api.promoCodes({ limit: PAGE_SIZE, offset: this.first() });
      if (seq === this.seq) this.data.set(data);
    } catch (cause) {
      if (seq === this.seq) this.error.set(adminErrorMessage(cause));
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }
}
