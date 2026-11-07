import {
  compileSmsRules,
  parseBankSms,
  payerHintMatchesProfile,
  rupeesToPaise,
  senderMatches,
} from "./upi-sms-parser.js";

/*
 * Every message below is INVENTED, in the format of a made-up "Example Bank"
 * (sender XMPLBK). These tests exercise the rule engine — amount and UTR
 * extraction, exclusion, account checks — not any real bank's wording. Real
 * formats are captured from the webhook and written as config; see
 * docs/upi-sms-payments.md.
 */
const RULES_JSON = JSON.stringify([
  {
    name: "xmpl-upi-credit",
    senders: ["XMPLBK"],
    match: "credited",
    exclude: "debited",
    amount: "INR\\s*(?<amount>[\\d,]+(?:\\.\\d{1,2})?)",
    utr: "Ref\\s*No\\.?\\s*(?<utr>\\d{12})",
    account: "A/c\\s*(?<account>[X*]*\\d{4})",
    payer: "from\\s+(?<payer>[\\w.@-]+)",
  },
]);

const rules = compileSmsRules(RULES_JSON);

const CREDIT =
  "Example Bank: INR 1,234.50 credited to A/c XX4321 on 07-11-26 from 9876543210@xmpl.\nRef No 412345678901. Not you? Call 1800-000-0000";

describe("compileSmsRules", () => {
  it("treats missing config as no rules", () => {
    expect(compileSmsRules(null)).toEqual([]);
    expect(compileSmsRules("  ")).toEqual([]);
  });

  it("names the rule and field at fault", () => {
    const missingGroup = JSON.stringify([{ name: "r1", match: "x", amount: "(\\d+)", utr: "(?<utr>\\d+)" }]);
    expect(() => compileSmsRules(missingGroup)).toThrow(/r1.*amount.*\(\?<amount>/);

    const badRegex = JSON.stringify([{ name: "r2", match: "(", amount: "(?<amount>\\d+)", utr: "(?<utr>\\d+)" }]);
    expect(() => compileSmsRules(badRegex)).toThrow(/r2.*match/);
  });

  it("rejects invalid JSON, a missing field and duplicate names", () => {
    expect(() => compileSmsRules("{not json")).toThrow(/valid JSON/);
    expect(() => compileSmsRules(JSON.stringify([{ name: "r", match: "x" }]))).toThrow(/invalid/);
    const rule = { name: "same", match: "x", amount: "(?<amount>\\d+)", utr: "(?<utr>\\d+)" };
    expect(() => compileSmsRules(JSON.stringify([rule, rule]))).toThrow(/two rules named "same"/);
  });
});

describe("senderMatches", () => {
  it("matches a whole DLT-header segment, case-insensitively", () => {
    expect(senderMatches("AX-XMPLBK", ["XMPLBK"])).toBe(true);
    expect(senderMatches("vm-xmplbk-s", ["XMPLBK"])).toBe(true);
    expect(senderMatches("XMPLBK", ["xmplbk"])).toBe(true);
  });

  it("does not accept a header that merely contains the token", () => {
    expect(senderMatches("AX-XMPLBKX", ["XMPLBK"])).toBe(false);
    expect(senderMatches("+919800000000", ["XMPLBK"])).toBe(false);
    expect(senderMatches("", ["XMPLBK"])).toBe(false);
  });
});

describe("rupeesToPaise", () => {
  it.each([
    ["1,234.50", 123450],
    ["1234.5", 123450],
    ["500", 50000],
    ["0.99", 99],
    ["1,00,000.00", 10000000],
  ])("%s → %d paise", (text, paise) => {
    expect(rupeesToPaise(text)).toBe(paise);
  });

  it.each(["", "0", "0.00", "12.345", "abc", "-5", "1e3"])("refuses %j", (text) => {
    expect(rupeesToPaise(text)).toBeNull();
  });
});

describe("parseBankSms", () => {
  it("reads a credit: amount in paise, UTR, account and payer", () => {
    expect(parseBankSms("AX-XMPLBK", CREDIT, rules, "4321")).toEqual({
      status: "credit",
      ruleName: "xmpl-upi-credit",
      amountMinor: 123450,
      utr: "412345678901",
      accountHint: "XX4321",
      payerHint: "9876543210@xmpl.",
    });
  });

  it("calls a debit not_credit, even though it mentions credit", () => {
    const debit = "Example Bank: INR 200.00 debited from A/c XX4321, credited to shop@xmpl. Ref No 412345678902";
    expect(parseBankSms("AX-XMPLBK", debit, rules, "4321")).toEqual({
      status: "not_credit",
      ruleName: "xmpl-upi-credit",
    });
  });

  it("rejects a credit to some other account", () => {
    const result = parseBankSms("AX-XMPLBK", CREDIT.replace("XX4321", "XX9999"), rules, "4321");
    expect(result).toMatchObject({ status: "rejected", amountMinor: 123450, utr: "412345678901" });
  });

  it("skips the account check when no last-4 is configured", () => {
    expect(parseBankSms("AX-XMPLBK", CREDIT.replace("XX4321", "XX9999"), rules, null).status).toBe("credit");
  });

  it("never returns a credit without a UTR", () => {
    const noUtr = CREDIT.replace(/Ref No \d+/, "Ref No pending");
    const result = parseBankSms("AX-XMPLBK", noUtr, rules, "4321");
    expect(result.status).toBe("unparsed");
    expect(result.status === "unparsed" ? result.note : "").toMatch(/no UTR/);
  });

  it("never returns a credit without an amount", () => {
    const noAmount = CREDIT.replace("INR 1,234.50", "money");
    const result = parseBankSms("AX-XMPLBK", noAmount, rules, "4321");
    expect(result.status).toBe("unparsed");
    expect(result.status === "unparsed" ? result.note : "").toMatch(/no amount/);
  });

  it("does not apply a rule to a sender it does not name", () => {
    expect(parseBankSms("AX-OTHRBK", CREDIT, rules, "4321")).toMatchObject({
      status: "unparsed",
      ruleName: null,
    });
  });

  it("leaves everything unparsed when there are no rules yet", () => {
    expect(parseBankSms("AX-XMPLBK", CREDIT, [], null)).toEqual({
      status: "unparsed",
      ruleName: null,
      note: "No parse rules are configured yet",
    });
  });
});

describe("payerHintMatchesProfile", () => {
  it("matches a payer VPA carrying the buyer's phone number", () => {
    expect(payerHintMatchesProfile("9876543210@xmpl", { phoneNumber: "+91 98765 43210", fullName: null })).toBe(true);
  });

  it("does not match a masked number on its last digits alone", () => {
    expect(payerHintMatchesProfile("XXXXXX3210", { phoneNumber: "9876543210", fullName: null })).toBe(false);
  });

  it("matches a full or bank-truncated name, but not a short fragment", () => {
    expect(payerHintMatchesProfile("ASHA VERMA", { phoneNumber: null, fullName: "Asha Verma" })).toBe(true);
    expect(payerHintMatchesProfile("ASHA VERM", { phoneNumber: null, fullName: "Asha Verma" })).toBe(true);
    expect(payerHintMatchesProfile("ASHA", { phoneNumber: null, fullName: "Asha Verma" })).toBe(false);
    expect(payerHintMatchesProfile("RAVI KUMAR", { phoneNumber: null, fullName: "Asha Verma" })).toBe(false);
  });

  it("matches nothing without a hint or profile details", () => {
    expect(payerHintMatchesProfile(null, { phoneNumber: "9876543210", fullName: "Asha Verma" })).toBe(false);
    expect(payerHintMatchesProfile("9876543210@xmpl", { phoneNumber: null, fullName: null })).toBe(false);
  });
});
