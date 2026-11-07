import { Component, computed, inject, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import type { AdminUpiOrderRow, AdminUpiReview, AdminUpiSmsRow } from '@tradesathi/shared';

import { AdminApiService, adminErrorMessage } from '../admin-api.service';
import { dateTime, money } from '../admin-format';

/**
 * UPI payments: the manual-verification queue.
 *
 * Most bank SMS settle their order on their own. What lands here is what did
 * not: a credit for an amount no open order has, one that fits two orders, an
 * SMS no parse rule could read, or one the account check rejected. Each can be
 * linked to an order (the API still insists the amounts agree) or dismissed.
 * An order whose SMS never arrived can be marked paid from the bank statement.
 *
 * Every action is recorded in upi_payment_events with the admin who took it.
 */
@Component({
  selector: 'app-admin-upi',
  imports: [ButtonModule, MessageModule, ProgressSpinnerModule],
  templateUrl: './admin-upi.html',
  styleUrls: ['../admin-section.css', './admin-upi.css'],
})
export class AdminUpiSection {
  private readonly api = inject(AdminApiService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<AdminUpiReview | null>(null);

  /** Which order each queued SMS is about to be linked to, and the note with it. */
  protected readonly choice = signal<Record<string, string | undefined>>({});
  protected readonly notes = signal<Record<string, string | undefined>>({});

  /** Ids (SMS or order) with an action in flight. */
  protected readonly saving = signal<ReadonlySet<string>>(new Set());

  /** The order whose mark-paid form is open, and its fields. */
  protected readonly markingId = signal<string | null>(null);
  protected readonly markUtr = signal('');
  protected readonly markNote = signal('');

  protected readonly money = money;
  protected readonly dateTime = dateTime;

  private readonly ordersById = computed(() => {
    const map = new Map<string, AdminUpiOrderRow>();
    for (const order of this.data()?.orders ?? []) map.set(order.id, order);
    return map;
  });

  constructor() {
    void this.load();
  }

  /** Orders to offer for an SMS: the suggested ones first, then the rest. */
  protected optionsFor(sms: AdminUpiSmsRow): { order: AdminUpiOrderRow; suggested: boolean }[] {
    const orders = this.data()?.orders ?? [];
    const suggested = new Set(sms.suggestedOrderIds);
    const first = sms.suggestedOrderIds
      .map((id) => this.ordersById().get(id))
      .filter((o): o is AdminUpiOrderRow => o !== undefined)
      .map((order) => ({ order, suggested: true }));
    const rest = orders.filter((o) => !suggested.has(o.id)).map((order) => ({ order, suggested: false }));
    return [...first, ...rest];
  }

  /** Whether an SMS carries what settling needs: an amount and a UTR. */
  protected canSettle(sms: AdminUpiSmsRow): boolean {
    return sms.amountMinor !== null && sms.utr !== null;
  }

  protected chosen(sms: AdminUpiSmsRow): string {
    return this.choice()[sms.id] ?? sms.suggestedOrderIds[0] ?? '';
  }

  protected setChoice(smsId: string, value: string): void {
    this.choice.update((c) => ({ ...c, [smsId]: value }));
  }

  protected setNote(smsId: string, value: string): void {
    this.notes.update((n) => ({ ...n, [smsId]: value }));
  }

  protected orderLabel(order: AdminUpiOrderRow): string {
    const who = order.fullName || order.email || order.profileId.slice(0, 8);
    return `${order.reference} · ${money(order.amountMinor, 'INR')} · ${who}`;
  }

  protected smsStatus(sms: AdminUpiSmsRow): { label: string; cls: string } {
    if (sms.parseStatus === 'unparsed') return { label: 'Not understood', cls: 'st st-queued' };
    if (sms.parseStatus === 'rejected') return { label: 'Rejected', cls: 'st st-failed' };
    switch (sms.matchStatus) {
      case 'matched':
        return { label: sms.matchedBy === 'admin' ? 'Settled by admin' : 'Settled', cls: 'st st-complete' };
      case 'ignored':
        return { label: 'Dismissed', cls: 'st st-queued' };
      case 'ambiguous':
        return { label: 'Fits several orders', cls: 'st st-processing' };
      case 'unmatched':
        return { label: 'No matching order', cls: 'st st-processing' };
      default:
        return { label: 'Pending', cls: 'st st-processing' };
    }
  }

  protected async settle(sms: AdminUpiSmsRow): Promise<void> {
    const paymentId = this.chosen(sms);
    if (!paymentId || this.saving().has(sms.id)) return;
    await this.run(sms.id, () =>
      this.api.matchUpiSms(sms.id, paymentId, this.notes()[sms.id]?.trim() || null),
    );
  }

  protected async dismiss(sms: AdminUpiSmsRow): Promise<void> {
    if (this.saving().has(sms.id)) return;
    await this.run(sms.id, () => this.api.ignoreUpiSms(sms.id, this.notes()[sms.id]?.trim() || null));
  }

  protected openMarkPaid(order: AdminUpiOrderRow): void {
    this.markingId.set(order.id);
    this.markUtr.set('');
    this.markNote.set('');
  }

  protected async markPaid(order: AdminUpiOrderRow): Promise<void> {
    if (this.saving().has(order.id)) return;
    const utr = this.markUtr().trim();
    const note = this.markNote().trim();
    if (!utr || !note) {
      this.error.set('Enter the UTR from the bank statement, and where you checked it.');
      return;
    }
    const ok = await this.run(order.id, () => this.api.markUpiOrderPaid(order.id, utr, note));
    if (ok) this.markingId.set(null);
  }

  /** Runs an action, then re-reads the queue so the screen shows what the server now holds. */
  private async run(id: string, action: () => Promise<void>): Promise<boolean> {
    this.saving.update((s) => new Set(s).add(id));
    this.error.set(null);
    try {
      await action();
      await this.load();
      return true;
    } catch (cause) {
      this.error.set(adminErrorMessage(cause));
      return false;
    } finally {
      this.saving.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await this.api.upiReview());
    } catch (cause) {
      this.error.set(adminErrorMessage(cause));
    } finally {
      this.loading.set(false);
    }
  }
}
