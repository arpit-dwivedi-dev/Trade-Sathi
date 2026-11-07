import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The invented "Example Bank" (sender XMPLBK) again — see upi-sms-parser.test.ts.
 * This file is about what ingestSms does with a parse result: what it stores,
 * when it asks the database to match, and how it breaks a tie.
 */
vi.mock("../lib/env.js", () => ({
  env: {
    upi: {
      enabled: true,
      payeeVpa: "owner.name@xmpl",
      payeeName: "Trade Sathi",
      webhookToken: "t".repeat(40),
      smsSenders: ["XMPLBK"],
      smsRulesJson: JSON.stringify([
        {
          name: "xmpl",
          match: "credited",
          exclude: "debited",
          amount: "INR\\s*(?<amount>[\\d,]+(?:\\.\\d{1,2})?)",
          utr: "Ref\\s*(?<utr>\\d{12})",
          payer: "from\\s+(?<payer>[\\w@.]+?)\\.?\\s",
        },
      ]),
      accountLast4: null,
      orderTtlMinutes: 15,
      smsGraceMinutes: 20,
    },
  },
}));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// credits.service builds the Razorpay client at import; only its wording is needed.
vi.mock("./credits.service.js", () => ({ rejectionMessage: () => "rejected" }));

const db = vi.hoisted(() => {
  type Result = { data: unknown; error: { code?: string; message: string } | null };
  const inserts: Record<string, unknown>[] = [];
  const insertResults: Result[] = [];
  let paymentsResult: Result = { data: [], error: null };
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<unknown>>();

  const from = vi.fn((table: string) => {
    if (table === "upi_sms_messages") {
      return {
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return { select: () => ({ single: () => Promise.resolve(insertResults.shift()) }) };
        },
      };
    }
    // payments, for the tie-break lookup
    return { select: () => ({ in: () => ({ returns: () => Promise.resolve(paymentsResult) }) }) };
  });

  return {
    inserts,
    insertResults,
    rpc,
    from,
    setPayments: (r: Result) => {
      paymentsResult = r;
    },
  };
});
vi.mock("../lib/supabase.js", () => ({ supabaseAdmin: { from: db.from }, callRpc: db.rpc }));

const { buildUpiUri, formatUpiAmount, ingestSms, newUpiReference, upiPurchasesAvailable } = await import(
  "./upi-payments.service.js"
);

const NOW = new Date("2026-11-07T10:00:00Z");
const CREDIT = "Example Bank: INR 198.63 credited to A/c XX4321 from 9876543210@xmpl. Ref 412345678901 -XMPL";

function sms(body: string, sender = "AX-XMPLBK") {
  return { sender, body, sentAt: new Date("2026-11-07T09:59:00Z"), receivedAt: new Date("2026-11-07T09:59:01Z") };
}

beforeEach(() => {
  db.inserts.length = 0;
  db.insertResults.length = 0;
  db.rpc.mockReset();
  db.from.mockClear();
});

describe("upi link", () => {
  it("formats paise without floating point", () => {
    expect(formatUpiAmount(19863)).toBe("198.63");
    expect(formatUpiAmount(100)).toBe("1.00");
    expect(formatUpiAmount(5)).toBe("0.05");
  });

  it("builds the NPCI link with the VPA unencoded and no merchant fields", () => {
    const uri = buildUpiUri({ payeeVpa: "owner.name@xmpl", payeeName: "Trade Sathi", amountMinor: 19863, reference: "TSUABC" });
    expect(uri).toBe("upi://pay?pa=owner.name@xmpl&pn=Trade%20Sathi&am=198.63&cu=INR&tn=TradeSathi%20TSUABC");
    expect(uri).not.toMatch(/[?&](tr|mc)=/);
  });

  it("makes readable references", () => {
    expect(newUpiReference()).toMatch(/^TSU[A-HJ-NP-Z2-9]{8}$/);
  });

  it("sells by UPI in India only", () => {
    expect(upiPurchasesAvailable("IN")).toBe(true);
    expect(upiPurchasesAvailable("GLOBAL")).toBe(false);
  });
});

describe("ingestSms", () => {
  it("drops an SMS from an unconfigured sender without storing it", async () => {
    expect(await ingestSms(sms(CREDIT, "AX-OTHRBK"), NOW)).toEqual({ outcome: "ignored_sender" });
    expect(db.inserts).toHaveLength(0);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("stores a credit and asks the database to match it", async () => {
    db.insertResults.push({ data: { id: "sms-1" }, error: null });
    db.rpc.mockResolvedValueOnce({ outcome: "matched", paymentId: "pay-1", profileId: "p-1" });

    expect(await ingestSms(sms(CREDIT), NOW)).toEqual({ outcome: "matched", smsId: "sms-1" });
    expect(db.inserts[0]).toMatchObject({
      sender: "AX-XMPLBK",
      parse_status: "credit",
      amount_minor: 19863,
      utr: "412345678901",
      match_status: "pending",
      received_at: "2026-11-07T09:59:01.000Z",
    });
    expect(db.rpc).toHaveBeenCalledWith("match_upi_sms", { p_sms_id: "sms-1", p_grace: "20 minutes" });
  });

  it("stores a debit for the record and never matches it", async () => {
    db.insertResults.push({ data: { id: "sms-2" }, error: null });
    const result = await ingestSms(sms("Example Bank: INR 50 debited from A/c XX4321 Ref 412345678902 "), NOW);
    expect(result.outcome).toBe("stored");
    expect(db.inserts[0]).toMatchObject({ parse_status: "not_credit", match_status: "not_applicable" });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("treats a forwarder retry as already handled", async () => {
    db.insertResults.push({
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "upi_sms_messages_dedupe_key_key"' },
    });
    expect(await ingestSms(sms(CREDIT), NOW)).toEqual({ outcome: "duplicate_delivery" });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("keeps a second SMS for the same UTR, rejected and unmatchable", async () => {
    db.insertResults.push(
      { data: null, error: { code: "23505", message: 'violates unique constraint "upi_sms_messages_utr_idx"' } },
      { data: { id: "sms-3" }, error: null },
    );
    expect(await ingestSms(sms(CREDIT), NOW)).toEqual({ outcome: "utr_seen", smsId: "sms-3" });
    expect(db.inserts[1]).toMatchObject({ parse_status: "rejected", utr: null, match_status: "not_applicable" });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("throws on any other database error, so the forwarder retries", async () => {
    db.insertResults.push({ data: null, error: { code: "08006", message: "connection failure" } });
    await expect(ingestSms(sms(CREDIT), NOW)).rejects.toThrow(/connection failure/);
  });

  it("falls back to arrival time when the phone's clock is implausible", async () => {
    db.insertResults.push({ data: { id: "sms-4" }, error: null });
    db.rpc.mockResolvedValueOnce({ outcome: "unmatched" });
    await ingestSms({ ...sms(CREDIT), receivedAt: new Date("2030-01-01T00:00:00Z") }, NOW);
    expect(db.inserts[0]).toMatchObject({ received_at: NOW.toISOString() });
  });

  it("settles an ambiguous SMS when the payer matches exactly one buyer", async () => {
    db.insertResults.push({ data: { id: "sms-5" }, error: null });
    db.rpc
      .mockResolvedValueOnce({ outcome: "ambiguous", candidateIds: ["pay-a", "pay-b"] })
      .mockResolvedValueOnce({ outcome: "matched", paymentId: "pay-b", profileId: "p-b" });
    db.setPayments({
      data: [
        { id: "pay-a", profiles: { phone_number: "9000000000", full_name: "Ravi Kumar" } },
        { id: "pay-b", profiles: { phone_number: "+91 98765 43210", full_name: "Asha Verma" } },
      ],
      error: null,
    });

    expect(await ingestSms(sms(CREDIT), NOW)).toEqual({ outcome: "matched", smsId: "sms-5" });
    expect(db.rpc).toHaveBeenLastCalledWith(
      "settle_upi_payment_from_sms",
      expect.objectContaining({ p_sms_id: "sms-5", p_payment_id: "pay-b", p_matched_by: "auto_payer_hint" }),
    );
  });

  it("leaves it ambiguous when the payer fits no one, or more than one", async () => {
    db.insertResults.push({ data: { id: "sms-6" }, error: null });
    db.rpc.mockResolvedValueOnce({ outcome: "ambiguous", candidateIds: ["pay-a", "pay-b"] });
    db.setPayments({
      data: [
        { id: "pay-a", profiles: { phone_number: "9876543210", full_name: null } },
        { id: "pay-b", profiles: { phone_number: "9876543210", full_name: null } },
      ],
      error: null,
    });

    expect(await ingestSms(sms(CREDIT), NOW)).toEqual({ outcome: "ambiguous", smsId: "sms-6" });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
});
