import { NgTemplateOutlet } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import { AppIcon } from '../../shared/icons/app-icon';
import type { IconName } from '../../shared/icons/icon-paths';

/** One row of the merged activity table, whichever table it came from. */
interface ActivityRow {
  id: string;
  kind: 'payment' | 'credits' | 'error';
  title: string;
  /** Integer minor units (paise), or null for rows that carry no money. */
  amountMinor: number | null;
  currency: string | null;
  status: string;
  /** The `st-*` class that colours the status pill. */
  statusClass: string;
  createdAt: string;
}

interface PaymentRow {
  id: string;
  credits_purchased: number;
  amount_minor: number;
  currency: string;
  status: string;
  created_at: string;
}

interface LedgerRow {
  id: string;
  delta: number;
  reason: string;
  feature_key: string | null;
  balance_after: number;
  created_at: string;
}

interface ErrorLogRow {
  id: string;
  category: string;
  message: string;
  created_at: string;
}

type ActivityFilter = 'all' | 'payment' | 'credits' | 'error';

const ROW_LIMIT = 20;

/** Cap on the merged list — 3 sources × ROW_LIMIT would otherwise be 60 rows. */
const MERGED_LIMIT = 50;

/**
 * The signed-in user's account activity, one table: what they paid (credit
 * purchases), what moved their credit balance, and any background failure the
 * API logged against them. All plain client-side reads under RLS
 * (payments/credit_ledger carry select-own policies; app_error_logs was added
 * for exactly this purpose).
 *
 * There is no more subscriptions table (there are no plans any more, just one
 * credit balance spent by every paid feature), so this page has one purchase
 * source, not two. The manual-run and briefing-log cards this page used to
 * render are gone for a separate reason: watchlist_analysis_runs rows exist
 * only while a run settles, and the settled result is already the History row
 * a user actually looks for — the logs page was showing a transient duplicate
 * of it.
 */
@Component({
  selector: 'app-logs-page',
  imports: [
    NgTemplateOutlet,
    AppIcon,
    CardModule,
    FormsModule,
    SelectButtonModule,
    TableModule,
  ],
  templateUrl: './logs-page.html',
  styleUrl: './logs-page.css',
})
export class LogsPage implements OnInit, OnDestroy {
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly rows = signal<ActivityRow[]>([]);
  protected readonly typeFilter = signal<ActivityFilter>('all');

  protected readonly typeFilters: { value: ActivityFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'payment', label: 'Payments' },
    { value: 'credits', label: 'Credits' },
    { value: 'error', label: 'Errors' },
  ];

  protected readonly kindIcons: Readonly<Record<ActivityRow['kind'], IconName>> = {
    payment: 'credit_card',
    credits: 'bolt',
    error: 'close',
  };

  protected readonly kindLabels: Readonly<Record<ActivityRow['kind'], string>> = {
    payment: 'Payment',
    credits: 'Credits',
    error: 'Error',
  };

  /** Open Realtime channel subscriptions; closed in ngOnDestroy. */
  private channels: RealtimeChannel[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /**
   * Coalescing window for Realtime events. Only app_error_logs is published
   * on the Realtime publication today (payments/credit_ledger are not), so
   * this exists for the error feed alone; a background failure arriving
   * while the page is open still shows up without a reload.
   */
  private static readonly RELOAD_DEBOUNCE_MS = 500;

  ngOnInit(): void {
    void this.load();
    this.watchErrors();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    const client = this.supabase.client;
    for (const channel of this.channels) void client?.removeChannel(channel);
    this.channels = [];
  }

  /**
   * app_error_logs only: the other three sources are not on the Realtime
   * publication, so subscribing to them would be a socket that never fires.
   * RLS scopes the subscription server-side; the profile filter is still
   * passed so the socket is not asked to carry anyone else's rows.
   */
  private watchErrors(): void {
    const client = this.supabase.client;
    const profileId = this.auth.user()?.id;
    if (!client || !profileId) return;

    const channel = client
      .channel(`logs-errors-${profileId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_error_logs', filter: `profile_id=eq.${profileId}` },
        () => this.scheduleReload(),
      )
      .subscribe();
    this.channels.push(channel);
  }

  private scheduleReload(): void {
    if (this.destroyed || this.reloadTimer !== null) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      // Skipped while a read is already in flight; that read is itself newer
      // than the event, and the next event reloads again anyway.
      if (this.destroyed || this.loading()) return;
      void this.load(true);
    }, LogsPage.RELOAD_DEBOUNCE_MS);
  }

  /**
   * `background` is set by the Realtime path: that read replaces content the
   * user is already looking at, and swapping a populated table for a skeleton
   * every time a row changes would be worse than the stale snapshot this
   * subscription exists to fix. It also leaves the last error banner alone
   * until it knows better, for the same reason.
   */
  protected async load(background = false): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;

    if (!background) {
      this.loading.set(true);
      this.error.set(null);
    }

    const [payments, ledger, errors] = await Promise.all([
      client
        .from('payments')
        .select('id, credits_purchased, amount_minor, currency, status, created_at')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT)
        .returns<PaymentRow[]>(),
      client
        .from('credit_ledger')
        .select('id, delta, reason, feature_key, balance_after, created_at')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT)
        .returns<LedgerRow[]>(),
      client
        .from('app_error_logs')
        .select('id, category, message, created_at')
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT)
        .returns<ErrorLogRow[]>(),
    ]);

    if (this.destroyed) return;

    if (payments.error || ledger.error || errors.error) {
      // A failed background refresh keeps whatever is on screen: it is still
      // valid, and the next event retries.
      if (!background) this.error.set('Could not load your activity.');
    } else {
      this.error.set(null);
      this.rows.set(mergeActivity(payments.data ?? [], ledger.data ?? [], errors.data ?? []));
    }
    if (!background) this.loading.set(false);
  }

  protected selectType(type: ActivityFilter): void {
    this.typeFilter.set(type);
  }

  /** p-table's `let-row` is untyped, so indexing the maps happens here. */
  protected kindIcon(kind: ActivityRow['kind']): IconName {
    return this.kindIcons[kind];
  }

  protected kindLabel(kind: ActivityRow['kind']): string {
    return this.kindLabels[kind];
  }

  /** Client-side — every source is already fetched and merged into `rows`. */
  protected visibleRows(): ActivityRow[] {
    const filter = this.typeFilter();
    return filter === 'all' ? this.rows() : this.rows().filter((row) => row.kind === filter);
  }

  /**
   * Paise → "₹499"; non-INR keeps its own code rather than a wrong symbol.
   */
  protected amountLabel(row: ActivityRow): string {
    if (row.amountMinor === null || row.currency === null) return '—';
    if (row.currency !== 'INR') return `${row.currency} ${(row.amountMinor / 100).toFixed(2)}`;
    return `₹${(row.amountMinor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }

  /** "31 Aug, 14:05" — enough for the user to recognise their own entry. */
  protected formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

/**
 * Human wording for an error category. app_error_logs.category is free text
 * by design (see its migration), so an unknown value falls back to itself
 * rather than being dropped — a new category from the API must never make a
 * row unreadable here.
 */
function categoryLabel(category: string): string {
  switch (category) {
    case 'analysis':
      return 'upload';
    case 'live_run':
      return 'live chart';
    case 'fundamentals_analysis':
      return 'fundamentals';
    case 'watchlist_run':
      return 'watchlist';
    case 'briefing':
      return 'daily briefing';
    default:
      return category;
  }
}

/** Human labels for a ledger row's feature_key — the closed set in FEATURE_CREDIT_KEYS. */
const FEATURE_LABELS: Readonly<Record<string, string>> = {
  chart_analysis: 'chart analysis',
  daily_briefing_run: 'daily briefing',
  fundamental_analysis: 'fundamental analysis',
};

/** Merges the three sources into one newest-first list. */
function mergeActivity(
  payments: PaymentRow[],
  ledger: LedgerRow[],
  errors: ErrorLogRow[],
): ActivityRow[] {
  const merged: ActivityRow[] = [
    ...payments.map((row) => ({
      id: row.id,
      kind: 'payment' as const,
      title: `${row.credits_purchased} credit${row.credits_purchased === 1 ? '' : 's'}`,
      amountMinor: row.amount_minor,
      currency: row.currency,
      status: row.status,
      statusClass: paymentStatusClass(row.status),
      createdAt: row.created_at,
    })),
    ...ledger.map((row) => ({
      id: row.id,
      kind: 'credits' as const,
      title: ledgerTitle(row),
      amountMinor: null,
      currency: null,
      status: row.delta >= 0 ? 'credited' : 'spent',
      statusClass: row.delta >= 0 ? 'st-complete' : 'st-queued',
      createdAt: row.created_at,
    })),
    ...errors.map((row) => ({
      id: row.id,
      kind: 'error' as const,
      // Category + message in one string: the merged row has a single title
      // column, and "watchlist: <message>" reads better than the raw message
      // with no provenance at all.
      title: `${categoryLabel(row.category)}: ${row.message}`,
      amountMinor: null,
      currency: null,
      status: 'failed',
      statusClass: 'st-failed',
      createdAt: row.created_at,
    })),
  ];

  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return merged.slice(0, MERGED_LIMIT);
}

function paymentStatusClass(status: string): string {
  switch (status) {
    case 'captured':
      return 'st-complete';
    case 'failed':
      return 'st-failed';
    default:
      // 'created' is awaiting payment, not a problem yet.
      return 'st-queued';
  }
}

/** The ledger row in words — what changed and why. */
function ledgerTitle(row: LedgerRow): string {
  const delta = `${row.delta >= 0 ? '+' : ''}${row.delta}`;
  const feature = row.feature_key ? (FEATURE_LABELS[row.feature_key] ?? row.feature_key) : null;
  switch (row.reason) {
    case 'purchase':
      return `${delta} credits — purchase (balance ${row.balance_after})`;
    case 'feature_consumption':
      return `${delta} credit${row.delta === -1 ? '' : 's'} — ${feature ?? 'usage'} (balance ${row.balance_after})`;
    case 'refund':
      return `${delta} credits — refund${feature ? ` (${feature})` : ''} (balance ${row.balance_after})`;
    case 'promo_credit':
      return `${delta} credits — promo code (balance ${row.balance_after})`;
    case 'admin_adjustment':
      return `${delta} credits — adjustment (balance ${row.balance_after})`;
    default:
      return `${delta} credits (balance ${row.balance_after})`;
  }
}
