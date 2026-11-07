import type {
  AdminUpiMatchStatus,
  AdminUpiOrderRow,
  AdminUpiParseStatus,
  AdminUpiReview,
  AdminUpiSmsRow,
} from "@tradesathi/shared";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";
import { payerHintMatchesProfile } from "./upi-sms-parser.js";

/**
 * The UPI review queue for the Admin panel: SMS that did not settle anything
 * on their own, the unpaid orders they might belong to, and the three manual
 * actions (link an SMS to an order, dismiss an SMS, mark an order paid with no
 * SMS). Service-role client throughout, so it must only be reached from
 * behind requireAdmin (routes/admin.route.ts).
 *
 * Every action goes through a SQL function that writes upi_payment_events, so
 * each manual decision is in the audit log with the admin who made it.
 */

const SMS_COLUMNS =
  "id, sender, body, received_at, rule_name, parse_status, parse_note, amount_minor, utr, account_hint, payer_hint, match_status, payment_id, matched_by, review_note";

interface SmsDbRow {
  id: string;
  sender: string;
  body: string;
  received_at: string;
  rule_name: string | null;
  parse_status: AdminUpiParseStatus;
  parse_note: string | null;
  amount_minor: number | null;
  utr: string | null;
  account_hint: string | null;
  payer_hint: string | null;
  match_status: AdminUpiMatchStatus;
  payment_id: string | null;
  matched_by: AdminUpiSmsRow["matchedBy"];
  review_note: string | null;
}

interface OrderDbRow {
  id: string;
  provider_order_id: string;
  status: string;
  amount_minor: number;
  credits_purchased: number;
  created_at: string;
  expires_at: string | null;
  profile_id: string;
  profiles: { email: string | null; full_name: string | null; phone_number: string | null } | null;
}

/** How far back unpaid orders are listed. A payment older than this is a support ticket, not a queue item. */
const ORDER_LOOKBACK_MS = 72 * 60 * 60_000;

function toOrder(row: OrderDbRow, now: number): AdminUpiOrderRow {
  // Expiry is applied lazily in the database, so a live-looking row may be past it.
  const expired = row.expires_at !== null && Date.parse(row.expires_at) <= now;
  return {
    id: row.id,
    reference: row.provider_order_id,
    status: row.status === "created" && expired ? "expired" : row.status,
    amountMinor: row.amount_minor,
    creditsPurchased: row.credits_purchased,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    profileId: row.profile_id,
    email: row.profiles?.email ?? null,
    fullName: row.profiles?.full_name ?? null,
    phoneNumber: row.profiles?.phone_number ?? null,
  };
}

/**
 * Orders this SMS could be for, best first: same amount AND a payer matching
 * the buyer, then same amount, then payer match alone (a buyer who paid the
 * wrong amount). Amount equality is required to settle, so the last group is
 * there to explain, not to link.
 */
export function suggestOrders(sms: AdminUpiSmsRow, orders: readonly AdminUpiOrderRow[]): string[] {
  const scored = orders
    .map((order) => {
      const sameAmount = sms.amountMinor !== null && order.amountMinor === sms.amountMinor;
      const payer = payerHintMatchesProfile(sms.payerHint, {
        phoneNumber: order.phoneNumber,
        fullName: order.fullName,
      });
      return { id: order.id, score: (sameAmount ? 2 : 0) + (payer ? 1 : 0) };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.id);
}

function toSms(row: SmsDbRow): AdminUpiSmsRow {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    receivedAt: row.received_at,
    ruleName: row.rule_name,
    parseStatus: row.parse_status,
    parseNote: row.parse_note,
    amountMinor: row.amount_minor,
    utr: row.utr,
    accountHint: row.account_hint,
    payerHint: row.payer_hint,
    matchStatus: row.match_status,
    paymentId: row.payment_id,
    matchedBy: row.matched_by,
    reviewNote: row.review_note,
    suggestedOrderIds: [],
  };
}

export async function getUpiReview(now = Date.now()): Promise<AdminUpiReview> {
  const [queueRes, recentRes, ordersRes] = await Promise.all([
    supabaseAdmin
      .from("upi_sms_messages")
      .select(SMS_COLUMNS)
      // Credits that settled nothing, plus bank SMS no rule could read (the
      // raw material for a new rule). Debits ('not_credit') are left out.
      .or(
        "match_status.in.(pending,unmatched,ambiguous)," +
          "and(parse_status.in.(unparsed,rejected),match_status.eq.not_applicable)",
      )
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<SmsDbRow[]>(),
    supabaseAdmin
      .from("upi_sms_messages")
      .select(SMS_COLUMNS)
      .in("match_status", ["matched", "ignored"])
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<SmsDbRow[]>(),
    supabaseAdmin
      .from("payments")
      .select(
        "id, provider_order_id, status, amount_minor, credits_purchased, created_at, expires_at, profile_id, profiles(email, full_name, phone_number)",
      )
      .eq("provider", "upi_direct")
      .in("status", ["created", "expired"])
      .gte("created_at", new Date(now - ORDER_LOOKBACK_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<OrderDbRow[]>(),
  ]);

  for (const res of [queueRes, recentRes, ordersRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  const orders = (ordersRes.data ?? []).map((row) => toOrder(row, now));
  const queue = (queueRes.data ?? []).map((row) => {
    const sms = toSms(row);
    return { ...sms, suggestedOrderIds: suggestOrders(sms, orders) };
  });

  return { queue, recent: (recentRes.data ?? []).map(toSms), orders };
}

export type AdminMatchOutcome =
  | "matched"
  | "sms_not_found"
  | "sms_not_credit"
  | "sms_already_matched"
  | "payment_not_found"
  | "payment_already_paid"
  | "amount_mismatch";

/** Settles an order from an SMS an admin picked. Same checks as the automatic match. */
export async function adminMatchSms(
  smsId: string,
  paymentId: string,
  adminId: string,
  note: string | null,
): Promise<AdminMatchOutcome> {
  const result = await callRpc<{ outcome: AdminMatchOutcome }>("settle_upi_payment_from_sms", {
    p_sms_id: smsId,
    p_payment_id: paymentId,
    p_matched_by: "admin",
    p_admin_id: adminId,
    p_note: note,
  });
  logger.info("admin linked upi sms to order", { adminId, smsId, paymentId, outcome: result.outcome });
  return result.outcome;
}

/** Takes an SMS out of the queue. False when there was no such SMS, or it already settled an order. */
export async function adminIgnoreSms(smsId: string, adminId: string, note: string | null): Promise<boolean> {
  const ignored = await callRpc<boolean>("admin_ignore_upi_sms", {
    p_sms_id: smsId,
    p_admin_id: adminId,
    p_note: note,
  });
  logger.info("admin dismissed upi sms", { adminId, smsId, ignored });
  return ignored;
}

export type AdminMarkPaidOutcome =
  | "applied"
  | "payment_not_found"
  | "payment_already_paid"
  | "utr_already_used"
  | "utr_has_sms";

/** Settles an order with no SMS, from a UTR the admin checked in the bank statement. */
export async function adminMarkUpiPaid(
  paymentId: string,
  utr: string,
  adminId: string,
  note: string,
): Promise<AdminMarkPaidOutcome> {
  const result = await callRpc<{ outcome: AdminMarkPaidOutcome }>("admin_mark_upi_paid", {
    p_payment_id: paymentId,
    p_utr: utr,
    p_admin_id: adminId,
    p_note: note,
  });
  logger.info("admin marked upi order paid", { adminId, paymentId, outcome: result.outcome });
  return result.outcome;
}
