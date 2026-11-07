/**
 * The billing/pricing contract shared between apps/api and apps/web: the
 * region model, the credit pricing/feature-cost overview returned by
 * GET /api/pricing, and promo-code redemption outcomes.
 *
 * TradeSathi is credit-only: there are no plans, subscriptions or fixed
 * top-up packs. One balance (profiles.credit_balance) is spent by every
 * paid feature at a centrally configured cost, and topped up by buying any
 * quantity of credits at the caller's region rate.
 *
 * Types only, per the packages/shared rule — no logic, nothing
 * framework-specific.
 */

/**
 * The two price bands. 'IN' bills in INR with the India rate; 'GLOBAL' bills
 * in USD. Detection maps a country to a band; it is not per-country pricing.
 * Mirrors the `pricing_region` Postgres enum
 * (20260830230000_region_pricing_and_credits.sql) — the two must agree.
 */
export type PricingRegion = 'IN' | 'GLOBAL';

/**
 * The caller's region and its current credit rate/purchase rules, as
 * returned by GET /api/pricing and read by the buy-credits UI.
 */
export interface CreditPricing {
  region: PricingRegion;
  /** ISO 4217, e.g. 'INR', 'USD'. */
  currency: string;
  /** Integer minor units (paise/cents) charged per credit. */
  pricePerCreditMinor: number;
  /** The smallest quantity of credits a purchase may request. */
  minPurchaseCredits: number;
  /**
   * The largest quantity of credits a purchase may request. Enforced by the
   * backend, not just by the buy form — a quantity outside [min, max] is a
   * 400 whatever sent it.
   */
  maxPurchaseCredits: number;
  /**
   * The step a quantity must be a multiple of, counted from
   * minPurchaseCredits: a quantity is valid only when
   * (quantity - minPurchaseCredits) % purchaseIncrementCredits === 0.
   *
   * Read from config rather than hardcoded in the buy form so the stepper's
   * step and the backend's validation cannot drift apart.
   */
  purchaseIncrementCredits: number;
  /**
   * Pre-filled quick-select amounts for the buy-credits UI, in minor units.
   * Display sugar only — not distinct SKUs. Any valid quantity between
   * minPurchaseCredits and maxPurchaseCredits can be purchased directly.
   */
  quickAmountsMinor: number[];
}

/**
 * One feature's cost in credits, as configured in feature_credit_costs.
 * Mirrors the key each service passes to consume_credits/refund_credits —
 * see FEATURE_CREDIT_KEYS below for the closed set of keys this app uses.
 */
export interface FeatureCreditCost {
  featureKey: string;
  credits: number;
}

/**
 * The closed set of feature keys this app currently spends credits on.
 * consume_credits/refund_credits accept any text key (the cost table is
 * pure config, extending it for a future feature is a data insert, not a
 * schema change) — this list is the application-level contract for which
 * keys the API and web app actually know how to trigger and display.
 */
export const FEATURE_CREDIT_KEYS = [
  'chart_analysis',
  'daily_briefing_run',
  'fundamental_analysis',
] as const;

export type FeatureCreditKey = (typeof FEATURE_CREDIT_KEYS)[number];

/** GET /api/pricing response. */
export interface PricingOverview {
  pricing: CreditPricing;
  featureCosts: FeatureCreditCost[];
  /**
   * Whether this caller can buy credits right now. Decided by the API
   * (UPI_PAYMENTS_ENABLED, and UPI moving rupees only, so the 'IN' region),
   * so switching purchases on is a server setting, not a web rebuild.
   */
  purchasesEnabled: boolean;
}

/**
 * A UPI QR order's state, as the buyer sees it.
 *
 * 'expired' is not final: a bank SMS for a payment made before the QR timed
 * out can still arrive until settleDeadline, and settles the order then.
 */
export type UpiOrderStatus = 'pending' | 'paid' | 'expired';

/** How to pay a pending UPI order: the link, the QR for it, and the payee. */
export interface UpiPaymentInstructions {
  /** upi://pay?… — scanned from the QR, or opened directly on a phone. */
  upiUri: string;
  /** PNG data URL of the QR for upiUri. Always dark-on-light. */
  qrDataUrl: string;
  payeeName: string;
  payeeVpa: string;
}

/**
 * POST /api/billing/upi/orders (201) and GET /api/billing/upi/orders/:id.
 * Money is integer paise.
 */
export interface UpiOrder {
  /** payments.id — what the status endpoint is asked about. */
  orderId: string;
  /** Our own reference, carried as the UPI note. */
  reference: string;
  status: UpiOrderStatus;
  /**
   * The exact amount to pay, in paise. Up to 99 paise below the price, so that
   * no two open orders share an amount — the bank SMS is matched on it.
   */
  amountMinor: number;
  currency: 'INR';
  creditsRequested: number;
  expiresAt: string;
  /** Until when a late bank SMS can still settle this order. */
  settleDeadline: string;
  /** Present while status is 'pending' and the caller asked for it; null otherwise. */
  payment: UpiPaymentInstructions | null;
}

/**
 * Result of POST /api/billing/redeem — mirrors redeem_promo_code_credits()'s
 * return values one for one.
 */
export type PromoRedeemOutcome =
  | 'applied'
  | 'duplicate'
  | 'invalid_code'
  | 'expired'
  | 'exhausted'
  | 'not_eligible_region';

/**
 * One row of a profile's credit history, as read directly from
 * credit_ledger (RLS select-own) for the billing page's transaction list.
 */
export interface CreditTransaction {
  id: string;
  /** Signed change in credits. */
  delta: number;
  reason: 'purchase' | 'feature_consumption' | 'refund' | 'promo_credit' | 'admin_adjustment';
  /** Set for feature_consumption/refund rows; null otherwise. */
  featureKey: string | null;
  /** Balance immediately after this row was applied. */
  balanceAfter: number;
  createdAt: string;
}
