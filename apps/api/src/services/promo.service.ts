import type { PricingRegion, PromoRedeemOutcome } from "@tradesathi/shared";
import { callRpc } from "../lib/supabase.js";

export type RedeemPromoResult =
  | { ok: true; outcome: "applied" }
  | { ok: false; outcome: Exclude<PromoRedeemOutcome, "applied"> };

/**
 * Redeems a promo code's free-credits component for one profile, via the
 * redeem_promo_code_credits() RPC so the cap check, the per-account count,
 * the balance update and the ledger row are one atomic operation — see that
 * function for the reasoning.
 *
 * Discount codes are a separate concern, validated in credits.service.ts at
 * order-creation time and finalized in apply_credit_purchase at capture time
 * — this function is specifically the free-credits redemption path used by
 * the Redeem page.
 *
 * The number of credits a code grants stays server-side (it varies per
 * code); the caller re-reads the balance separately rather than through this
 * result.
 *
 * 'invalid_code' covers unknown, inactive, and discount-only codes alike:
 * distinguishing them would tell a caller which guessed codes used to be
 * real, or exist but do something else.
 */
export async function redeemPromoCodeCredits(
  profileId: string,
  code: string,
  region: PricingRegion,
): Promise<RedeemPromoResult> {
  const outcome = await callRpc<PromoRedeemOutcome>("redeem_promo_code_credits", {
    p_profile_id: profileId,
    p_code: code,
    p_region: region,
  });

  if (outcome === "applied") {
    return { ok: true, outcome };
  }

  return { ok: false, outcome };
}
