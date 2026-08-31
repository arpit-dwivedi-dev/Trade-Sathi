import { Component, OnInit, inject, input, output, signal } from '@angular/core';

import { SupabaseClientService } from '../../core/supabase-client';

/**
 * The free tier's key. It is listed on a card for orientation but is never
 * purchasable — see isChoosable().
 */
const FREE_PLAN_KEY = 'free';

/**
 * Manual-analysis tiers, where a user holds exactly one at a time and moving
 * between them is not built — see isChoosable(). Anything not in this set
 * (e.g. 'daily_briefing_monthly') is an independent add-on: purchasable
 * regardless of which manual tier the user is on, since it doesn't occupy
 * the same profiles.plan_id slot.
 */
const MANUAL_PLAN_KEYS = new Set(['free', 'starter_monthly', 'pro_monthly', 'pro_annual']);

/** One plan, as rendered on a card. */
export interface PurchasablePlan {
  key: string;
  name: string;
  analysesPerMonth: number;
  amountMinor: number;
}

/**
 * Shape returned by the plan_prices query below. The embedded `plans` row is
 * an object (not an array) because plan_id is a to-one FK.
 */
interface PlanPriceRow {
  amount_minor: number;
  plans: { key: string; name: string; analyses_per_month: number } | null;
}

/**
 * plans.analyses_per_month is intentionally 0 for add-on plans like
 * 'daily_briefing_monthly' — that column belongs to the manual-analysis
 * entitlement contract, and the add-on's real monthly allowance lives in
 * daily_briefing_entitlements instead (see
 * 20260831160200_daily_briefing_plan_seed.sql). Reading 0 straight through
 * would show a misleading "0 analyses / month" on its card, so this table
 * substitutes the real per-plan-key quota for display only.
 */
interface DailyBriefingEntitlementRow {
  plan_key: string;
  monthly_auto_analyses: number;
}

/**
 * The plan cards. Lists every tier including free — free is there to show the
 * user where they stand, not as something to buy.
 *
 * Renders inline, with no dialog of its own: it is always shown inside the
 * plans overlay, and giving it a second modal layer put the cards two clicks
 * and two stacked backdrops away from the user. The overlay is the only modal.
 *
 * Reads straight from Supabase like fetchPlanSummary()/fetchQuota() do — both
 * plans and plan_prices have client-readable select policies for is_active
 * rows, so no backend endpoint is needed.
 *
 * region is hardcoded to 'IN', matching the backend's purchase-time lookup;
 * region detection is not built yet.
 */
@Component({
  selector: 'app-plan-picker',
  styleUrl: './plan-picker.css',
  templateUrl: './plan-picker.html',
})
export class PlanPicker implements OnInit {
  private readonly supabase = inject(SupabaseClientService);

  /**
   * The plan the user is on right now, so its card can be marked rather than
   * offered. null when it could not be read — every card then stays unmarked,
   * which is the safe fallback: nothing is mislabelled as current.
   */
  readonly currentPlanKey = input.required<string | null>();

  readonly planSelected = output<string>();

  protected readonly plans = signal<PurchasablePlan[] | null>(null);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  /**
   * Free is shown for orientation only — there is no downgrade-to-free purchase
   * flow, so its card is never actionable regardless of which plan the user is
   * on. An add-on (e.g. 'daily_briefing_monthly') is always offered, since it
   * doesn't occupy the manual-plan slot and isn't a "switch tiers" action.
   * Switching between manual tiers is not built, so a manual-tier card is
   * offered only from 'free' — matching the previous behavior for those keys.
   */
  protected isChoosable(plan: PurchasablePlan): boolean {
    if (plan.key === FREE_PLAN_KEY || plan.key === this.currentPlanKey()) return false;
    if (!MANUAL_PLAN_KEYS.has(plan.key)) return true;
    return this.currentPlanKey() === FREE_PLAN_KEY;
  }

  protected isCurrent(plan: PurchasablePlan): boolean {
    return plan.key === this.currentPlanKey();
  }

  /** Paise → "₹399", matching AccountPage.priceLabel. Free reads as "Free". */
  protected priceLabel(amountMinor: number): string {
    if (amountMinor === 0) return 'Free';
    return `₹${(amountMinor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }

  protected onChoose(plan: PurchasablePlan): void {
    // Guards the emit as well as the template: the free card and the current
    // plan's card render no button, and neither may become selectable by any
    // other route either.
    if (!this.isChoosable(plan)) return;
    this.planSelected.emit(plan.key);
  }

  private async load(): Promise<void> {
    const client = this.supabase.client;
    // SSR has no Supabase client. Leaving plans() null renders the loading
    // state, and ngOnInit runs again in the browser to fill it in.
    if (!client) return;

    try {
      const [{ data, error }, entitlements] = await Promise.all([
        client
          .from('plan_prices')
          .select('amount_minor, plans!inner(key, name, analyses_per_month)')
          .eq('region', 'IN')
          .eq('is_active', true)
          // Cheapest first, so free reads before Starter before Pro.
          .order('amount_minor', { ascending: true })
          .returns<PlanPriceRow[]>(),
        client
          .from('daily_briefing_entitlements')
          .select('plan_key, monthly_auto_analyses')
          .returns<DailyBriefingEntitlementRow[]>(),
      ]);

      if (error) throw error;

      const addonQuota = new Map(
        (entitlements.data ?? []).map((row) => [row.plan_key, row.monthly_auto_analyses]),
      );

      this.plans.set(
        (data ?? [])
          .filter((row): row is PlanPriceRow & { plans: NonNullable<PlanPriceRow['plans']> } =>
            row.plans !== null,
          )
          .map((row) => ({
            key: row.plans.key,
            name: row.plans.name,
            analysesPerMonth: addonQuota.get(row.plans.key) ?? row.plans.analyses_per_month,
            amountMinor: row.amount_minor,
          })),
      );
    } catch (cause) {
      console.warn('plan list lookup failed', cause);
      this.error.set("Couldn't load the plans. Please try again.");
    }
  }
}
