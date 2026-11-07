import { createHash, randomInt } from "node:crypto";
import QRCode from "qrcode";
import type {
  PricingRegion,
  UpiOrder,
  UpiOrderStatus,
  UpiPaymentInstructions,
} from "@tradesathi/shared";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";
import { rejectionMessage, type BeginCreditPurchaseRejection } from "./credits.service.js";
import {
  compileSmsRules,
  parseBankSms,
  payerHintMatchesProfile,
  senderMatches,
  type SmsParseResult,
} from "./upi-sms-parser.js";

/**
 * Credit purchases paid by UPI QR to the owner's own VPA, and the bank SMS
 * that confirm them. The database half — amount allocation, matching, the
 * grant — lives in 20260925120100_upi_sms_payments.sql; this module is the
 * part that cannot be SQL: the QR, the SMS parsing, and the tie-break that
 * reads buyer profiles.
 *
 * Nothing the buyer's browser says is ever taken as proof of payment. An order
 * is paid only when a bank SMS (or an admin) says so.
 */

/** Compiled once, at startup: a bad UPI_SMS_RULES fails the boot, not the first payment. */
const rules = compileSmsRules(env.upi.smsRulesJson);

/** Every sender id an SMS may come from: UPI_SMS_SENDERS plus any a rule names. */
const allowedSenders: readonly string[] = [
  ...new Set([...env.upi.smsSenders.map((s) => s.toUpperCase()), ...rules.flatMap((r) => r.senders ?? [])]),
];

const ttl = `${env.upi.orderTtlMinutes} minutes`;
const grace = `${env.upi.smsGraceMinutes} minutes`;

/** Whether this caller could buy credits right now. UPI moves rupees only. */
export function upiPurchasesAvailable(region: PricingRegion): boolean {
  return env.upi.enabled && region === "IN";
}

/** Easy to read out over the phone: no 0/O or 1/I/L. */
const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Our order reference, e.g. TSU7K2M9QX4. It travels as the UPI note. */
export function newUpiReference(): string {
  let ref = "TSU";
  for (let i = 0; i < 8; i++) ref += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return ref;
}

/** Paise to the "123.45" form a upi:// link carries. Integer arithmetic only. */
export function formatUpiAmount(amountMinor: number): string {
  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`;
}

/**
 * The upi:// payment link (NPCI's deep-link format).
 *
 * The amount is fixed in the link, which is what makes it unique per order.
 * The reference goes in tn (the note), which every UPI app shows the payer.
 * tr and mc are deliberately absent: they are merchant fields, and several
 * apps decline a personal VPA's payment when they are present. The VPA is
 * written unencoded — env.ts has already held it to a safe charset — because
 * some apps refuse an encoded "@".
 */
export function buildUpiUri(input: {
  payeeVpa: string;
  payeeName: string;
  amountMinor: number;
  reference: string;
}): string {
  return (
    `upi://pay?pa=${input.payeeVpa}` +
    `&pn=${encodeURIComponent(input.payeeName)}` +
    `&am=${formatUpiAmount(input.amountMinor)}` +
    `&cu=INR` +
    `&tn=${encodeURIComponent(`TradeSathi ${input.reference}`)}`
  );
}

async function paymentInstructions(amountMinor: number, reference: string): Promise<UpiPaymentInstructions> {
  // Non-null: upiPurchasesAvailable gates every caller, and env.ts refuses to
  // start with purchases on and no VPA.
  const payeeVpa = env.upi.payeeVpa!;
  const upiUri = buildUpiUri({ payeeVpa, payeeName: env.upi.payeeName, amountMinor, reference });
  // Fixed black on white whatever the page theme: an inverted QR is one some
  // scanners cannot read.
  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
    color: { dark: "#000000", light: "#ffffff" },
  });
  return { upiUri, qrDataUrl, payeeName: env.upi.payeeName, payeeVpa };
}

function settleDeadline(expiresAt: string): string {
  return new Date(Date.parse(expiresAt) + env.upi.smsGraceMinutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Buyer side
// ---------------------------------------------------------------------------

type BeginUpiOutcome =
  | {
      ok: true;
      paymentId: string;
      reference: string;
      amountMinor: number;
      priceMinor: number;
      currency: string;
      creditsRequested: number;
      expiresAt: string;
    }
  | BeginCreditPurchaseRejection
  | { ok: false; reason: "busy" };

export type CreateUpiOrderResult =
  | { ok: true; order: UpiOrder }
  | {
      ok: false;
      reason: "disabled" | "busy" | BeginCreditPurchaseRejection["reason"];
      message: string;
    };

/**
 * Opens a UPI order for a quantity of credits and returns the QR to pay it.
 * Pricing, bounds and promo validation are begin_credit_purchase's, unchanged;
 * the buyer's earlier unpaid QR, if any, is replaced.
 */
export async function createUpiOrder(
  profileId: string,
  region: PricingRegion,
  quantity: number,
  promoCode: string | null,
): Promise<CreateUpiOrderResult> {
  if (!env.upi.enabled) {
    return { ok: false, reason: "disabled", message: "Purchases are paused during the free beta" };
  }
  if (region !== "IN") {
    return { ok: false, reason: "region_unavailable", message: "UPI payments are only available in India" };
  }

  const trimmed = promoCode?.trim();
  const claimed = await callRpc<BeginUpiOutcome>("begin_upi_credit_purchase", {
    p_profile_id: profileId,
    p_region: region,
    p_quantity: quantity,
    p_promo_code: trimmed ? trimmed : null,
    p_reference: newUpiReference(),
    p_ttl: ttl,
    p_reuse_after: grace,
  });

  if (!claimed.ok) {
    if (claimed.reason === "busy") {
      return {
        ok: false,
        reason: "busy",
        message: "A lot of payments are in progress right now. Please try again in a few minutes.",
      };
    }
    return { ok: false, reason: claimed.reason, message: rejectionMessage(claimed) };
  }

  logger.info("upi order created", {
    profileId,
    paymentId: claimed.paymentId,
    amountMinor: claimed.amountMinor,
    offsetMinor: claimed.priceMinor - claimed.amountMinor,
  });

  return {
    ok: true,
    order: {
      orderId: claimed.paymentId,
      reference: claimed.reference,
      status: "pending",
      amountMinor: claimed.amountMinor,
      currency: "INR",
      creditsRequested: claimed.creditsRequested,
      expiresAt: claimed.expiresAt,
      settleDeadline: settleDeadline(claimed.expiresAt),
      payment: await paymentInstructions(claimed.amountMinor, claimed.reference),
    },
  };
}

interface UpiPaymentRow {
  id: string;
  provider_order_id: string;
  status: string;
  amount_minor: number;
  credits_purchased: number;
  expires_at: string;
}

/**
 * The buyer's own UPI order, or null if it is not theirs (or not UPI). Read
 * from our payments row only — the client polls this and has no say in it.
 *
 * withInstructions regenerates the QR, for a buyer resuming after a reload;
 * the poll leaves it off, since nothing about it changes.
 */
export async function getUpiOrder(
  profileId: string,
  orderId: string,
  withInstructions: boolean,
): Promise<UpiOrder | null> {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("id, provider_order_id, status, amount_minor, credits_purchased, expires_at")
    .eq("id", orderId)
    .eq("profile_id", profileId)
    .eq("provider", "upi_direct")
    .maybeSingle<UpiPaymentRow>();
  if (error) throw new Error(error.message);
  if (!data) return null;

  // 'created' past its expiry is expired; the row is only flipped lazily, by
  // the next order allocation.
  const status: UpiOrderStatus =
    data.status === "captured"
      ? "paid"
      : data.status === "created" && Date.parse(data.expires_at) > Date.now()
        ? "pending"
        : "expired";

  return {
    orderId: data.id,
    reference: data.provider_order_id,
    status,
    amountMinor: data.amount_minor,
    currency: "INR",
    creditsRequested: data.credits_purchased,
    expiresAt: data.expires_at,
    settleDeadline: settleDeadline(data.expires_at),
    payment:
      status === "pending" && withInstructions && env.upi.payeeVpa !== null
        ? await paymentInstructions(data.amount_minor, data.provider_order_id)
        : null,
  };
}

// ---------------------------------------------------------------------------
// SMS side
// ---------------------------------------------------------------------------

export interface IncomingSms {
  sender: string;
  body: string;
  /** The phone's sent/received stamps, when the forwarder supplied them. */
  sentAt: Date | null;
  receivedAt: Date | null;
}

export type IngestOutcome =
  | "ignored_sender"
  | "duplicate_delivery"
  | "utr_seen"
  | "stored"
  | "matched"
  | "duplicate"
  | "unmatched"
  | "ambiguous";

type MatchResult =
  | { outcome: "matched"; paymentId: string; profileId: string }
  | { outcome: "duplicate"; paymentId: string }
  | { outcome: "ambiguous"; candidateIds: string[] }
  | { outcome: "unmatched" | "not_applicable" | "sms_not_found" }
  | { outcome: string };

/**
 * The time the SMS reached the phone, which is what an order's window is held
 * against. The forwarder may deliver late (no signal, retries), so the phone's
 * stamp beats our arrival time — unless it is implausible, which a wrong phone
 * clock or a bad payload would make it.
 */
function receivedTime(sms: IncomingSms, now: Date): Date {
  const at = sms.receivedAt;
  if (at === null || Number.isNaN(at.getTime())) return now;
  const ms = at.getTime();
  const sevenDays = 7 * 24 * 60 * 60_000;
  if (ms > now.getTime() + 5 * 60_000 || ms < now.getTime() - sevenDays) return now;
  return at;
}

/** Last four characters only: enough to find it in the bank app, not the whole reference. */
function utrTail(utr: string | null): string | null {
  return utr === null ? null : `…${utr.slice(-4)}`;
}

function parsedColumns(parse: SmsParseResult) {
  switch (parse.status) {
    case "credit":
      return {
        rule_name: parse.ruleName,
        parse_status: "credit",
        parse_note: null,
        amount_minor: parse.amountMinor,
        utr: parse.utr,
        account_hint: parse.accountHint,
        payer_hint: parse.payerHint,
        match_status: "pending",
      };
    case "rejected":
      return {
        rule_name: parse.ruleName,
        parse_status: "rejected",
        parse_note: parse.note,
        amount_minor: parse.amountMinor,
        utr: parse.utr,
        account_hint: null,
        payer_hint: null,
        match_status: "not_applicable",
      };
    case "not_credit":
      return { rule_name: parse.ruleName, parse_status: "not_credit", parse_note: null, match_status: "not_applicable" };
    case "unparsed":
      return { rule_name: parse.ruleName, parse_status: "unparsed", parse_note: parse.note, match_status: "not_applicable" };
  }
}

/**
 * Stores one forwarded SMS and, if it is a credit, tries to settle an order
 * with it. Called by the webhook for every delivery, retries included.
 *
 * Only SMS from a configured bank sender are stored at all — anything else
 * the phone forwards (OTPs, personal messages) is dropped unread, so a broad
 * forwarder filter does not end up writing private texts to the database.
 *
 * Throws only on a database failure, which the webhook answers with a 500 so
 * the forwarder retries; the dedupe key makes the retry harmless.
 */
export async function ingestSms(sms: IncomingSms, now = new Date()): Promise<{ outcome: IngestOutcome; smsId?: string }> {
  if (!senderMatches(sms.sender, allowedSenders)) {
    logger.info("sms webhook: sender not configured, dropped", { sender: sms.sender });
    return { outcome: "ignored_sender" };
  }

  const parse = parseBankSms(sms.sender, sms.body, rules, env.upi.accountLast4);
  const dedupeKey = createHash("sha256")
    .update(`${sms.sender}\n${sms.body}\n${sms.sentAt?.toISOString() ?? ""}`)
    .digest("hex");

  const base = {
    sender: sms.sender,
    body: sms.body,
    dedupe_key: dedupeKey,
    sent_at: sms.sentAt && !Number.isNaN(sms.sentAt.getTime()) ? sms.sentAt.toISOString() : null,
    received_at: receivedTime(sms, now).toISOString(),
  };

  let { data, error } = await supabaseAdmin
    .from("upi_sms_messages")
    .insert({ ...base, ...parsedColumns(parse) })
    .select("id")
    .single<{ id: string }>();

  if (error?.code === "23505" && error.message.includes("dedupe_key")) {
    // The forwarder retried a delivery we already have.
    return { outcome: "duplicate_delivery" };
  }

  let outcome: IngestOutcome | null = null;
  if (error?.code === "23505" && error.message.includes("utr")) {
    // A different message carrying a UTR we have already seen: the same
    // transfer, reported twice. Kept for the record, never matched.
    ({ data, error } = await supabaseAdmin
      .from("upi_sms_messages")
      .insert({
        ...base,
        ...parsedColumns(parse),
        parse_status: "rejected",
        parse_note: "Another SMS already reported this UTR",
        utr: null,
        match_status: "not_applicable",
      })
      .select("id")
      .single<{ id: string }>());
    outcome = "utr_seen";
  }

  if (error || !data) {
    throw new Error(`could not store sms: ${error?.message ?? "no row returned"}`);
  }
  const smsId = data.id;

  if (outcome !== null || parse.status !== "credit") {
    logger.info("sms webhook: stored", {
      smsId,
      parseStatus: parse.status,
      rule: parse.ruleName,
      outcome: outcome ?? "stored",
    });
    return { outcome: outcome ?? "stored", smsId };
  }

  const result = await callRpc<MatchResult>("match_upi_sms", { p_sms_id: smsId, p_grace: grace });
  let final = result.outcome as IngestOutcome;

  if (result.outcome === "ambiguous" && "candidateIds" in result) {
    final = await breakTieByPayer(smsId, parse.payerHint, result.candidateIds);
  }

  const log = final === "matched" || final === "duplicate" ? logger.info : logger.warn;
  log("sms webhook: credit processed", {
    smsId,
    rule: parse.ruleName,
    amountMinor: parse.amountMinor,
    utr: utrTail(parse.utr),
    outcome: final,
    paymentId: "paymentId" in result ? result.paymentId : undefined,
  });
  return { outcome: final, smsId };
}

/**
 * Two orders fit the SMS (rare: only a late SMS overlapping a reused amount).
 * If the payer the SMS names matches exactly one candidate's profile — their
 * phone in the payer's VPA, or their name — that one is settled. Anything
 * less certain stays 'ambiguous' for an admin.
 */
async function breakTieByPayer(
  smsId: string,
  payerHint: string | null,
  candidateIds: string[],
): Promise<IngestOutcome> {
  if (payerHint === null) return "ambiguous";

  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("id, profiles(phone_number, full_name)")
    .in("id", candidateIds)
    .returns<{ id: string; profiles: { phone_number: string | null; full_name: string | null } | null }[]>();
  if (error) throw new Error(error.message);

  const fits = (data ?? []).filter((row) =>
    payerHintMatchesProfile(payerHint, {
      phoneNumber: row.profiles?.phone_number ?? null,
      fullName: row.profiles?.full_name ?? null,
    }),
  );
  if (fits.length !== 1) return "ambiguous";

  const settled = await callRpc<{ outcome: string }>("settle_upi_payment_from_sms", {
    p_sms_id: smsId,
    p_payment_id: fits[0].id,
    p_matched_by: "auto_payer_hint",
    p_admin_id: null,
    p_note: "The payer in the SMS matched this buyer's profile",
  });
  return settled.outcome === "matched" ? "matched" : "ambiguous";
}
