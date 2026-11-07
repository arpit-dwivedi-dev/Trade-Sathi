/**
 * The free-beta credit code, as the landing page and the app print it.
 *
 * The row itself is seeded by
 * supabase/migrations/20260923120000_free_beta_promo_code.sql — renaming the
 * code, or changing what it grants, has to be done in both places.
 */
export const BETA_PROMO_CODE = 'BETA5';
export const BETA_PROMO_CREDITS = 5;

// Whether credits can be bought is no longer a build-time constant here: the
// API decides it (UPI_PAYMENTS_ENABLED) and says so in GET /api/pricing — see
// BillingService.purchasesEnabled. While it is off, the Billing screen says
// payments are coming soon and out-of-credits prompts offer the beta code.
