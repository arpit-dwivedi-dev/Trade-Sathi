/**
 * The billing/pricing contract shared between apps/api and apps/web: the
 * region model, the public pricing overview returned by GET /api/pricing,
 * and the promo-code redemption outcome.
 *
 * Types only, per the packages/shared rule — no logic, nothing
 * framework-specific.
 */

/**
 * The two price bands. 'IN' bills in INR with the India price list; 'GLOBAL'
 * bills in USD. Detection maps a country to a band; it is not per-country
 * pricing. Mirrors the `pricing_region` Postgres enum
 * (20260830230000_region_pricing_and_credits.sql) — the two must agree.
 */
export type PricingRegion = 'IN' | 'GLOBAL';

/**
 * One active (plan, region) price row, as returned by GET /api/pricing and
 * read by the plan picker. `currency` travels with the row because a region's
 * billing currency is a business decision recorded on each plan_prices row,
 * not something to derive from the region in code.
 */
export interface PublicPlanPrice {
  /** plans.key — 'free', 'starter_monthly', 'pro_monthly', … */
  key: string;
  name: string;
  analysesPerMonth: number;
  /** Integer minor units (paise or cents). */
  amountMinor: number;
  currency: string;
}

/**
 * The entry pass: a one-time, once-per-account purchase of 5 analysis
 * credits through the Razorpay Order flow (not a subscription, so it has no
 * plan_prices row — this object is how its price reaches clients).
 */
export interface EntryPassPrice {
  /** Integer minor units. */
  amountMinor: number;
  currency: string;
  credits: number;
}

/**
 * One top-up pack's price in the caller's region. Only packs actually on sale
 * there are listed: a region with no price for a pack must not advertise it,
 * because the order endpoint answers such a purchase with 'pack_unavailable'.
 *
 * The entry pass is not one of these — it is a one-time purchase rather than a
 * top-up, and it travels as `entryPass` above, which also carries its grant.
 */
export interface PublicTopUpPackPrice {
  /** Which balance the pack tops up. Mirrors CreditPackKind in the web app. */
  kind: 'analysis' | 'daily_briefing';
  /** Integer minor units. */
  amountMinor: number;
  currency: string;
  /** Credits the pack grants. */
  credits: number;
}

/** GET /api/pricing response: the caller's region and its active price list. */
export interface PricingOverview {
  region: PricingRegion;
  plans: PublicPlanPrice[];
  entryPass: EntryPassPrice;
  topUpPacks: PublicTopUpPackPrice[];
}

/**
 * Result of POST /api/billing/redeem-promo — mirrors redeem_promo_code()'s
 * return values one for one.
 */
export type PromoRedeemOutcome =
  | 'applied'
  | 'duplicate'
  | 'invalid_code'
  | 'expired'
  | 'exhausted';
