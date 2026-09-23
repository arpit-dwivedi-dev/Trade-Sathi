import { randomInt } from "node:crypto";
import type { AdminPage, AdminPromoCodeCreated, AdminPromoCodeRow } from "@tradesathi/shared";
import { supabaseAdmin } from "../lib/supabase.js";
import { escapeLike, type PageParams } from "./admin.service.js";

/**
 * Promo codes for the Admin panel: list them, create them, switch them on and
 * off. Every call goes through the service-role client, so it must only ever
 * be reached from behind requireAdmin (routes/admin.route.ts).
 *
 * Only the free-credit side of a code is managed here. Discount codes still go
 * through the internal ops route, and a code made for one email may not carry
 * a discount at all (see 20260923130000_promo_code_restricted_email.sql).
 */

const COLUMNS =
  "id, code, free_credits, discount_percent, discount_fixed_minor, restricted_email, max_redemptions, redemption_count, per_user_limit, expires_at, is_active, created_at";

/** Easy to read out and retype: no 0/O or 1/I/L to confuse. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GENERATED_LENGTH = 8;

/**
 * A generated code colliding with an existing one is vanishingly rare (31^8
 * combinations), so this bound only exists to rule out an endless loop.
 */
const GENERATE_ATTEMPTS = 3;

interface PromoCodeDbRow {
  id: string;
  code: string;
  free_credits: number | null;
  discount_percent: number | string | null;
  discount_fixed_minor: number | null;
  restricted_email: string | null;
  max_redemptions: number | null;
  redemption_count: number;
  per_user_limit: number;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

/** What createPromoCode is given, already validated by the route. */
export interface PromoCodeInput {
  /** Upper-cased; null means generate one. */
  code: string | null;
  credits: number;
  /** Lower-cased; null means anyone may redeem it. */
  email: string | null;
  maxRedemptions: number | null;
  perUserLimit: number;
  expiresAt: string | null;
}

export type CreatePromoCodeResult =
  | ({ ok: true } & AdminPromoCodeCreated)
  | { ok: false; reason: "code_taken" };

function toRow(r: PromoCodeDbRow): AdminPromoCodeRow {
  return {
    id: r.id,
    code: r.code,
    freeCredits: r.free_credits,
    hasDiscount: r.discount_percent !== null || r.discount_fixed_minor !== null,
    restrictedEmail: r.restricted_email,
    maxRedemptions: r.max_redemptions,
    redemptionCount: r.redemption_count,
    perUserLimit: r.per_user_limit,
    expiresAt: r.expires_at,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

export function generatePromoCode(): string {
  let code = "TS-";
  for (let i = 0; i < GENERATED_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Newest first. */
export async function listPromoCodes(params: PageParams): Promise<AdminPage<AdminPromoCodeRow>> {
  const { data, error, count } = await supabaseAdmin
    .from("promo_codes")
    .select(COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);
  if (error) throw new Error(`promo codes failed: ${error.message}`);
  return {
    rows: ((data ?? []) as PromoCodeDbRow[]).map(toRow),
    total: count ?? 0,
    limit: params.limit,
    offset: params.offset,
  };
}

/**
 * Creates a free-credit code. A code the admin typed is refused when it is
 * already taken; a generated one is simply drawn again.
 */
export async function createPromoCode(input: PromoCodeInput): Promise<CreatePromoCodeResult> {
  const attempts = input.code ? 1 : GENERATE_ATTEMPTS;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data, error } = await supabaseAdmin
      .from("promo_codes")
      .insert({
        code: input.code ?? generatePromoCode(),
        free_credits: input.credits,
        restricted_email: input.email,
        max_redemptions: input.maxRedemptions,
        per_user_limit: input.perUserLimit,
        expires_at: input.expiresAt,
      })
      .select(COLUMNS)
      .single();

    // 23505: unique_violation on promo_codes_code_ci_idx — the code is taken.
    if (error?.code === "23505") {
      if (input.code) return { ok: false, reason: "code_taken" };
      continue;
    }
    if (error) throw new Error(`promo code insert failed: ${error.message}`);

    return {
      ok: true,
      row: toRow(data),
      accountExists: input.email ? await hasAccount(input.email) : null,
    };
  }

  throw new Error("could not generate an unused promo code");
}

/** False when no such code exists. */
export async function setPromoCodeActive(id: string, active: boolean): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("promo_codes")
    .update({ is_active: active })
    .eq("id", id)
    .select("id");
  if (error) throw new Error(`promo code update failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Case-insensitive, like the email match redeem_promo_code_credits makes. */
async function hasAccount(email: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .ilike("email", escapeLike(email));
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return (count ?? 0) > 0;
}
