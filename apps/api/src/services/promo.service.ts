import type { PromoRedeemOutcome } from "@chartanalyzer/shared";
import { callRpc } from "../lib/supabase.js";

export type RedeemPromoResult =
  | { ok: true; outcome: "applied" }
  | { ok: false; outcome: Exclude<PromoRedeemOutcome, "applied"> };

/**
 * Redeems a promo code for one profile, via the redeem_promo_code() RPC so
 * the cap check, the one-per-account insert, the balance update and the
 * ledger row are one atomic operation — see that function for the reasoning.
 *
 * The number of credits a code grants stays server-side (it varies per code);
 * the caller re-reads the balance through the plan summary rather than this
 * result.
 *
 * 'invalid_code' covers unknown AND inactive codes alike: distinguishing them
 * would tell a caller which guessed codes used to be real.
 */
export async function redeemPromoCode(
  profileId: string,
  code: string,
): Promise<RedeemPromoResult> {
  const outcome = await callRpc<PromoRedeemOutcome>("redeem_promo_code", {
    p_profile_id: profileId,
    p_code: code,
  });

  if (outcome === "applied") {
    return { ok: true, outcome };
  }

  return { ok: false, outcome };
}
