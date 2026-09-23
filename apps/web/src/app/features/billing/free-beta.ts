import { environment } from '../../../environments/environment';

/**
 * The free-beta credit code, as the landing page and the app print it.
 *
 * The row itself is seeded by
 * supabase/migrations/20260923120000_free_beta_promo_code.sql — renaming the
 * code, or changing what it grants, has to be done in both places.
 */
export const BETA_PROMO_CODE = 'BETA5';
export const BETA_PROMO_CREDITS = 5;

/**
 * Whether credits can be bought in this build.
 *
 * Off in production builds for the free beta: no payment gateway has approved
 * this website yet, so the Billing screen says payments are coming soon and
 * every out-of-credits prompt offers the beta code instead of a Buy button.
 * The API refuses purchases on its own too (BILLING_ENABLED in apps/api).
 *
 * On in development builds (`ng serve` swaps in environment.development.ts),
 * so the purchase flow can still be tried locally against Razorpay test keys.
 */
export const PURCHASES_ENABLED = !environment.production;
