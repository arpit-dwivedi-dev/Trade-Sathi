import type { PricingRegion, PublicTopUpPackPrice } from "@chartanalyzer/shared";
import { env } from "../lib/env.js";
import { razorpay } from "../lib/razorpay-client.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * What one pack costs in one region. A pack sold in a single currency lists
 * only that region; a pack with no row for the caller's region is not for
 * sale there, which `createCreditOrder` reports as 'pack_unavailable' rather
 * than silently charging the wrong currency.
 *
 * Money is integer minor units (paise / cents), never a float.
 */
interface RegionPrice {
  amountMinor: number;
  currency: string;
}

/**
 * The credit packs on sale, keyed by what they top up.
 *
 * Three SKUs. `analysis` credits are spent on user-initiated analyses
 * (profiles.credit_balance); `daily_briefing` credits are spent on automated
 * watchlist runs (profiles.daily_briefing_credit_balance). They are
 * deliberately not interchangeable — a briefing run costs us a full model call
 * with no user waiting on it, and letting one balance pay for the other would
 * make either price wrong.
 *
 * `entry_pass` is the paid way into a paywalled account: a one-time,
 * once-per-account purchase of 5 analysis credits at a lower price than the
 * recurring tiers. It is an Order, not a Subscription, so it reuses this
 * machinery and needs no Razorpay dashboard Plan object — but it IS priced
 * per region (₹49 / $5), unlike the two top-up packs which are INR-only
 * until international pricing for them is a deliberate decision.
 *
 * A briefing top-up exists because the Daily Briefing add-on is a
 * subscription, and buying that subscription a second time would charge every
 * month while granting nothing: its allowance comes from the plan's
 * daily_briefing_entitlements row, not from a count of subscriptions. Packs
 * stack within a month (10 + 10 + 10); a second subscription cannot.
 *
 * `purpose` is what the webhook routes on, and is stored on the payments row —
 * so these strings are persisted history and must not be reused for a
 * different pack if one is ever repriced.
 */
/** One pack's catalogue row: what it's called on the payments row, what it
 * grants, and what it costs per region. */
interface CreditPackDef {
  purpose: string;
  credits: number;
  prices: Partial<Record<PricingRegion, RegionPrice>>;
}

/**
 * Typed explicitly (not `as const satisfies`) so each pack's `prices` widens
 * to the same `Partial<Record<PricingRegion, RegionPrice>>` shape. Under
 * `satisfies` alone, each literal keeps only the region keys it was written
 * with (e.g. analysis's `{ IN: ... }`), and indexing it with a `PricingRegion`
 * variable — as createCreditOrder and entryPassPriceFor both do — fails to
 * type-check because 'GLOBAL' isn't a key of that narrower literal type.
 */
const CREDIT_PACKS: Record<"analysis" | "daily_briefing" | "entry_pass", CreditPackDef> = {
  analysis: {
    purpose: "credit_pack_10",
    credits: 10,
    prices: { IN: { amountMinor: 7900, currency: "INR" } },
  },
  daily_briefing: {
    purpose: "daily_briefing_credit_pack_10",
    credits: 10,
    // Priced above the analysis pack: a briefing run renders its own chart and
    // makes the same model call, with no user waiting on the result.
    prices: { IN: { amountMinor: 9900, currency: "INR" } },
  },
  entry_pass: {
    purpose: "entry_pass_5",
    credits: 5,
    prices: {
      IN: { amountMinor: 4900, currency: "INR" },
      GLOBAL: { amountMinor: 500, currency: "USD" },
    },
  },
};

/** Which balance a pack tops up. */
export type CreditPackKind = keyof typeof CREDIT_PACKS;

/** The entry pass's price in one region, for GET /api/pricing. Null when a
 * region has no entry-pass price — none today, but the catalogue decides. */
export function entryPassPriceFor(region: PricingRegion): {
  amountMinor: number;
  currency: string;
  credits: number;
} | null {
  const price = CREDIT_PACKS.entry_pass.prices[region];
  if (!price) return null;
  return { amountMinor: price.amountMinor, currency: price.currency, credits: CREDIT_PACKS.entry_pass.credits };
}

/** The packs that top up a balance. entry_pass is a one-time purchase rather
 * than a top-up, and is published by entryPassPriceFor instead. */
const TOP_UP_PACK_KINDS = ["analysis", "daily_briefing"] as const;

/**
 * The top-up packs on sale in one region, for GET /api/pricing.
 *
 * Priced from this catalogue rather than from constants in the web app: the
 * amount a button advertises has to be the amount createCreditOrder charges,
 * and one source is the only way to guarantee that. A pack with no price here
 * is omitted, which is the same fact createCreditOrder reports as
 * 'pack_unavailable' — so a client rendering only what it is given cannot
 * offer a purchase this file would refuse.
 */
export function topUpPackPricesFor(region: PricingRegion): PublicTopUpPackPrice[] {
  return TOP_UP_PACK_KINDS.flatMap((kind) => {
    const price = CREDIT_PACKS[kind].prices[region];
    return price
      ? [
          {
            kind,
            amountMinor: price.amountMinor,
            currency: price.currency,
            credits: CREDIT_PACKS[kind].credits,
          },
        ]
      : [];
  });
}

/**
 * Which SQL function grants a captured payment's credits, by the purpose
 * stored on the payments row.
 *
 * The webhook routes on this rather than deciding for itself: the purpose was
 * written when the order was created, so a payment can only ever grant the
 * currency it was sold as, no matter what the webhook payload claims.
 *
 * The entry pass shares apply_credit_purchase with the top-up packs: it is
 * the same grant (N credits to profiles.credit_balance off a captured Order,
 * with the payments row carrying how many), so a second function would be a
 * copy with one different constant.
 */
export const CREDIT_GRANT_FUNCTION_BY_PURPOSE: Readonly<Record<string, string>> = {
  [CREDIT_PACKS.analysis.purpose]: "apply_credit_purchase",
  [CREDIT_PACKS.daily_briefing.purpose]: "apply_daily_briefing_credit_purchase",
  [CREDIT_PACKS.entry_pass.purpose]: "apply_credit_purchase",
};

export type CreateCreditOrderResult =
  | { ok: true; orderId: string; keyId: string; amountMinor: number; currency: string }
  | {
      ok: false;
      reason: "provider_error" | "pack_unavailable" | "already_purchased";
      message: string;
    };

/**
 * Creates a Razorpay Order for one credit pack and records it locally,
 * returning the identifiers Razorpay Checkout needs on the client.
 *
 * Orders are Razorpay's one-time-payment primitive, entirely distinct from
 * the Subscriptions API used for pro_monthly/starter_monthly: no dashboard
 * "Plan" object exists or is needed for a credit pack, and nothing here touches
 * public.subscriptions.
 *
 * The price comes from the pack's row for the caller's region — the same
 * region resolution the subscription path uses, so the two purchase paths can
 * never disagree about what a user is charged.
 *
 * The entry pass is once per account: a prior captured payment with its
 * purpose means the account has already used it, and the answer is
 * 'already_purchased' rather than a second charge. Abandoned ('created')
 * checkouts do not count — nothing was paid.
 *
 * Expected outcomes are returned as a discriminated result; only genuinely
 * unexpected failures (DB errors) throw, and the route maps those to 500.
 */
export async function createCreditOrder(
  profileId: string,
  kind: CreditPackKind,
  region: PricingRegion,
): Promise<CreateCreditOrderResult> {
  const pack = CREDIT_PACKS[kind];
  const price = pack.prices[region];
  if (!price) {
    return {
      ok: false,
      reason: "pack_unavailable",
      message: "That pack is not available in your region",
    };
  }

  // Once-per-account gate for the entry pass. Checked before the Order is
  // created so a second attempt never gets as far as Razorpay. The count is
  // not a lock — two concurrent attempts could both pass — but the worst case
  // is a second order created and abandoned; credits are only ever granted by
  // apply_credit_purchase off a CAPTURED payment, and a captured entry-pass
  // payment past the first is a support refund, not a balance corruption.
  if (kind === "entry_pass") {
    const { count, error: countError } = await supabaseAdmin
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId)
      .eq("purpose", pack.purpose)
      .eq("status", "captured");
    if (countError) {
      throw countError;
    }
    if ((count ?? 0) > 0) {
      return {
        ok: false,
        reason: "already_purchased",
        message: "This account has already used its entry pass",
      };
    }
  }

  // (a) Create the Razorpay Order.
  //
  // notes carry the profile id so a purchase can be traced back from the
  // Razorpay dashboard, but they are NOT the mechanism the webhook uses to
  // attribute the payment — that goes through the payments row written below,
  // which is our own record and cannot be influenced by the client.
  let order;
  try {
    order = await razorpay.orders.create({
      amount: price.amountMinor,
      currency: price.currency,
      notes: { profile_id: profileId, purpose: pack.purpose },
    });
  } catch {
    // The caught error is deliberately not inspected, forwarded, or logged
    // here: Razorpay error payloads can echo request details and key material,
    // and nothing from them may reach a response body. The route logs a
    // generic failure instead.
    return {
      ok: false,
      reason: "provider_error",
      message: "The payment provider could not create the order",
    };
  }

  // (b) Record the pending purchase.
  //
  // status='created' and signature_verified=false are the honest state right
  // now: an order exists, nothing has been paid, and no signature has been
  // checked. The apply_* function this pack's purpose routes to is the only
  // thing that moves either — it runs after the webhook route verifies the
  // signature over the raw body. Credits are granted there and nowhere else.
  const { error: insertError } = await supabaseAdmin.from("payments").insert({
    profile_id: profileId,
    provider: "razorpay",
    provider_order_id: order.id,
    purpose: pack.purpose,
    credits_granted: pack.credits,
    amount_minor: price.amountMinor,
    currency: price.currency,
    status: "created",
    signature_verified: false,
  });
  if (insertError) {
    throw insertError;
  }

  // (c) RAZORPAY_KEY_ID is the publishable key and is safe to return — it is
  // what Razorpay Checkout's JS widget needs on the frontend. The secret key
  // must never appear in any response body, log line, or error message.
  return {
    ok: true,
    orderId: order.id,
    keyId: env.razorpayKeyId,
    amountMinor: price.amountMinor,
    currency: price.currency,
  };
}
