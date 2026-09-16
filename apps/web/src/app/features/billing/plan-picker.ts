import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import type { PricingRegion } from '@chartanalyzer/shared';

import { SupabaseClientService } from '../../core/supabase-client';
import { formatPriceMinor, MANUAL_PLAN_KEYS } from './billing.service';

/**
 * The free tier's key. Its row still exists (new signups are assigned it) but
 * grants nothing — see isChoosable(). It is listed on a card for orientation
 * only, never as something to buy.
 */
const FREE_PLAN_KEY = 'free';

/**
 * The tier the product recommends, marked on its card. Hardcoded for the same
 * reason PURCHASABLE_PLAN_KEYS is server-side: there is one recommended SKU,
 * and it is a merchandising choice rather than a column on plans. A key that
 * matches no card simply marks nothing.
 */
const MOST_POPULAR_PLAN_KEY = 'pro_monthly';

/** One plan, as rendered on a card. */
export interface PurchasablePlan {
  key: string;
  name: string;
  analysesPerMonth: number;
  amountMinor: number;
  currency: string;
}

/**
 * Shape returned by the plan_prices query below. The embedded `plans` row is
 * an object (not an array) because plan_id is a to-one FK.
 */
interface PlanPriceRow {
  amount_minor: number;
  currency: string;
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
 * The region comes in as an input (BillingService's read of the profile's
 * locked pricing_region) rather than being hardcoded: it must be the same
 * region the backend's purchase-time lookup uses, or the card would show one
 * price and Checkout charge another. Null (not yet loaded / read failure)
 * falls back to 'IN' — the backend's own detection fallback, and the only
 * region with chargeable prices today.
 */
@Component({
  selector: 'app-plan-picker',
  imports: [NgTemplateOutlet, ButtonModule, CardModule, ProgressSpinnerModule],
  styleUrl: './plan-picker.css',
  templateUrl: './plan-picker.html',
})
export class PlanPicker {
  private readonly supabase = inject(SupabaseClientService);

  /**
   * The plan the user is on right now, so its card can be marked rather than
   * offered. null when it could not be read — every card then stays unmarked,
   * which is the safe fallback: nothing is mislabelled as current.
   */
  readonly currentPlanKey = input.required<string | null>();

  /**
   * Add-ons the user already holds. Separate from currentPlanKey on purpose:
   * currentPlanKey names the one manual tier a user occupies, and an add-on is
   * never that — so without this input a held add-on had no way to be marked
   * as current, and was offered for sale again.
   */
  readonly heldAddOnKeys = input.required<ReadonlySet<string>>();

  /**
   * The price band to list: the profile's locked pricing_region. See the
   * class comment — this must match what the backend charges.
   */
  readonly region = input<PricingRegion | null>(null);

  readonly planSelected = output<string>();

  protected readonly plans = signal<PurchasablePlan[] | null>(null);
  protected readonly error = signal<string | null>(null);

  /**
   * The two families, rendered as two sections rather than one list of cards.
   * A monthly tier and an add-on answer different questions ("which plan am I
   * on?" vs "what else have I switched on?"), and mixing them into one row of
   * identical cards is what made the add-on read as a fourth tier that would
   * replace the user's current one.
   */
  protected readonly manualPlans = computed(
    () => this.plans()?.filter((plan) => MANUAL_PLAN_KEYS.has(plan.key)) ?? [],
  );
  protected readonly addOnPlans = computed(
    () => this.plans()?.filter((plan) => !MANUAL_PLAN_KEYS.has(plan.key)) ?? [],
  );

  /** The region the current plan list was loaded for, or null before load. */
  private loadedRegion: PricingRegion | null = null;

  /**
   * Bumped per load; a load whose generation is no longer the newest discards
   * its own result. See load().
   */
  private loadGeneration = 0;

  constructor() {
    // Reacting to the region input rather than loading once in ngOnInit: the
    // picker can mount before the shared plan summary resolves (the billing
    // page), in which case region() is still null. Null falls back to 'IN' —
    // the backend's own detection fallback — and a late non-null value
    // re-queries, so a GLOBAL user briefly sees the IN list rather than a
    // dead spinner or, worse, buying against the wrong band. The lock means
    // the region never changes twice.
    effect(() => {
      const region = this.region() ?? 'IN';
      if (region !== this.loadedRegion) void this.load(region);
    });
  }

  /**
   * Free is shown for orientation only — there is no downgrade-to-free purchase
   * flow, so its card is never actionable regardless of which plan the user is
   * on. An add-on is offered regardless of manual tier, since it doesn't occupy
   * the manual-plan slot and isn't a "switch tiers" action — but only when the
   * user doesn't already hold it, because the backend rejects a second live
   * subscription to the same plan with a 409 the user can do nothing about.
   * Switching between manual tiers is not built, so a manual-tier card is
   * offered only from 'free' — matching the previous behavior for those keys.
   */
  protected isChoosable(plan: PurchasablePlan): boolean {
    if (plan.key === FREE_PLAN_KEY || this.isCurrent(plan)) return false;
    if (!MANUAL_PLAN_KEYS.has(plan.key)) return true;
    return this.currentPlanKey() === FREE_PLAN_KEY;
  }

  /**
   * "Current" means the user's manual tier for a manual plan, and "already
   * subscribed" for an add-on — the two families record it in different places
   * (profiles.plan_id vs a live subscriptions row), which is exactly why a held
   * add-on could not be marked before.
   */
  protected isCurrent(plan: PurchasablePlan): boolean {
    return MANUAL_PLAN_KEYS.has(plan.key)
      ? plan.key === this.currentPlanKey()
      : this.heldAddOnKeys().has(plan.key);
  }

  /**
   * Whether this is the tier the product recommends. Rendered as a badge and
   * nothing else — the card's own border is reserved for the plan the user is
   * actually on, so the two markers never read as the same state.
   */
  protected isMostPopular(plan: PurchasablePlan): boolean {
    return plan.key === MOST_POPULAR_PLAN_KEY;
  }

  /**
   * Add-on quota is automated briefing runs, not the manual analyses the tier
   * cards count. Labelling both "analyses / month" implied the add-on's 30
   * replaced the tier's allowance rather than sitting beside it.
   */
  protected quotaUnit(plan: PurchasablePlan): string {
    return MANUAL_PLAN_KEYS.has(plan.key) ? 'analyses / month' : 'briefings / month';
  }

  /** Minor units + currency → "₹399" / "$9". Zero (Free plan) renders as "—". */
  protected priceLabel(plan: PurchasablePlan): string {
    return formatPriceMinor(plan.amountMinor, plan.currency);
  }

  protected onChoose(plan: PurchasablePlan): void {
    // Guards the emit as well as the template: the free card and the current
    // plan's card render no button, and neither may become selectable by any
    // other route either.
    if (!this.isChoosable(plan)) return;
    this.planSelected.emit(plan.key);
  }

  private async load(region: PricingRegion): Promise<void> {
    const client = this.supabase.client;
    // SSR has no Supabase client. Leaving plans() null renders the loading
    // state, and the effect above re-runs in the browser to fill it in.
    if (!client) return;

    // Two loads can overlap — the effect fires again when the region input
    // resolves — and without this the slower one would win, leaving a GLOBAL
    // account on the INR price list with loadedRegion claiming it was current
    // and nothing left to correct it. Only the newest load may write.
    const generation = ++this.loadGeneration;

    try {
      const [{ data, error }, entitlements] = await Promise.all([
        client
          .from('plan_prices')
          .select('amount_minor, currency, plans!inner(key, name, analyses_per_month)')
          .eq('region', region)
          .eq('is_active', true)
          // Cheapest first, so Free plan reads before Starter before Pro.
          .order('amount_minor', { ascending: true })
          .returns<PlanPriceRow[]>(),
        client
          .from('daily_briefing_entitlements')
          .select('plan_key, monthly_auto_analyses')
          .returns<DailyBriefingEntitlementRow[]>(),
      ]);

      if (generation !== this.loadGeneration) return;

      if (error) throw error;
      // Checked, not ignored. The substitution below is the only reason an
      // add-on card shows a real quota — plans.analyses_per_month is 0 for it
      // — so falling back to that column on a failed read would print
      // "0 briefings / month" and read as a product decision.
      if (entitlements.error) throw entitlements.error;

      const addonQuota = new Map(
        (entitlements.data ?? []).map((row) => [row.plan_key, row.monthly_auto_analyses]),
      );

      // Record the loaded band only after a successful read: a failed query
      // must not stop the effect from retrying on its next run.
      this.loadedRegion = region;
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
            currency: row.currency,
          })),
      );
    } catch (cause) {
      if (generation !== this.loadGeneration) return;
      console.warn('plan list lookup failed', cause);
      this.error.set("Couldn't load the plans. Please try again.");
    }
  }
}
