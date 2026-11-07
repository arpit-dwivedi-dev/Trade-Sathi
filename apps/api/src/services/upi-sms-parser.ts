import { z } from "zod";

/**
 * Reads a forwarded bank SMS into a credit (amount, UTR, account, payer) using
 * rules from config (UPI_SMS_RULES). No bank's format is built in: every bank
 * words its alerts differently and changes them without notice, so a format
 * guessed here would be wrong in a way that settles the wrong order. Rules
 * are written from real messages the webhook has captured — see
 * docs/upi-sms-payments.md.
 *
 * Pure: no I/O, no env. The payments service hands it the config.
 */

/** One rule as written in UPI_SMS_RULES. Each pattern is a JS regex source, matched case-insensitively. */
const ruleSchema = z.object({
  name: z.string().min(1).max(64),
  /** Restricts the rule to these sender ids. Omitted: any allowed sender. */
  senders: z.array(z.string().min(2).max(32)).optional(),
  /** Must match for the rule to apply at all — the message family, e.g. "credited". */
  match: z.string().min(1),
  /** If it matches, the SMS is not a credit (a debit, a reversal, a mandate notice). Checked first. */
  exclude: z.string().min(1).optional(),
  /** Must contain a named group (?<amount>…), e.g. 1,234.50 */
  amount: z.string().min(1),
  /** Must contain a named group (?<utr>…) — the UPI reference / RRN. */
  utr: z.string().min(1),
  /** Optional; named group (?<account>…). Held against UPI_ACCOUNT_LAST4. */
  account: z.string().min(1).optional(),
  /** Optional; named group (?<payer>…) — a VPA or name, for review and tie-breaks. */
  payer: z.string().min(1).optional(),
});

export interface SmsRule {
  name: string;
  /** Upper-cased sender tokens, or null for any allowed sender. */
  senders: string[] | null;
  match: RegExp;
  exclude: RegExp | null;
  amount: RegExp;
  utr: RegExp;
  account: RegExp | null;
  payer: RegExp | null;
}

function compilePattern(rule: string, field: string, source: string, group: string | null): RegExp {
  let regex: RegExp;
  try {
    regex = new RegExp(source, "i");
  } catch (cause) {
    throw new Error(`UPI_SMS_RULES rule "${rule}": ${field} is not a valid regex (${String(cause)})`);
  }
  if (group !== null && !source.includes(`(?<${group}>`)) {
    throw new Error(`UPI_SMS_RULES rule "${rule}": ${field} must contain a named group (?<${group}>…)`);
  }
  return regex;
}

/**
 * Validates and compiles UPI_SMS_RULES. Throws with a message naming the rule
 * and field at fault, so a typo fails the deploy rather than silently
 * leaving every SMS unparsed. Null or empty config is no rules at all: the
 * webhook still stores bank SMS, as 'unparsed', for rules to be written from.
 */
export function compileSmsRules(json: string | null): SmsRule[] {
  if (json === null || json.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("UPI_SMS_RULES must be valid JSON (a JSON array of rules, on one line)");
  }

  const result = z.array(ruleSchema).safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `UPI_SMS_RULES is invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown error"}`,
    );
  }

  const names = new Set<string>();
  return result.data.map((raw) => {
    if (names.has(raw.name)) {
      throw new Error(`UPI_SMS_RULES has two rules named "${raw.name}"`);
    }
    names.add(raw.name);
    return {
      name: raw.name,
      senders: raw.senders ? raw.senders.map((s) => s.trim().toUpperCase()) : null,
      match: compilePattern(raw.name, "match", raw.match, null),
      exclude: raw.exclude ? compilePattern(raw.name, "exclude", raw.exclude, null) : null,
      amount: compilePattern(raw.name, "amount", raw.amount, "amount"),
      utr: compilePattern(raw.name, "utr", raw.utr, "utr"),
      account: raw.account ? compilePattern(raw.name, "account", raw.account, "account") : null,
      payer: raw.payer ? compilePattern(raw.name, "payer", raw.payer, "payer") : null,
    };
  });
}

/**
 * Whether a sender id is one of the configured ones.
 *
 * Compared by whole segment, not substring: Indian bank SMS arrive from DLT
 * headers like "AX-HDFCBK" or "VM-HDFCBK-S", where the bank's six characters
 * are one segment. A substring test would also accept "HDFCBKX", which is a
 * different (and possibly someone else's) header.
 */
export function senderMatches(sender: string, tokens: readonly string[]): boolean {
  const upper = sender.trim().toUpperCase();
  if (upper === "") return false;
  const segments = upper.split(/[^A-Z0-9]+/).filter((s) => s.length > 0);
  return tokens.some((token) => {
    const t = token.trim().toUpperCase();
    return t !== "" && (upper === t || segments.includes(t));
  });
}

/**
 * A rupee amount as written in an SMS ("1,234.5", "Rs.500", "INR 25.00"),
 * captured by the rule's amount group, to integer paise. String arithmetic,
 * never a float: 0.1 + 0.2 is not how money is counted. Null when it is not a
 * plain amount.
 */
export function rupeesToPaise(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "").padEnd(2, "0"));
  const total = rupees * 100 + paise;
  return total > 0 ? total : null;
}

/** UPI RRNs are 12 digits; IMPS/NEFT-style references can be alphanumeric. */
function normaliseUtr(text: string): string | null {
  const cleaned = text.replace(/\s/g, "").toUpperCase();
  return /^[A-Z0-9]{6,35}$/.test(cleaned) ? cleaned : null;
}

function group(regex: RegExp, body: string, name: string): string | null {
  const value = regex.exec(body)?.groups?.[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : null;
}

export type SmsParseResult =
  | {
      status: "credit";
      ruleName: string;
      amountMinor: number;
      utr: string;
      accountHint: string | null;
      payerHint: string | null;
    }
  | { status: "not_credit"; ruleName: string }
  | { status: "unparsed"; ruleName: string | null; note: string }
  | { status: "rejected"; ruleName: string; note: string; amountMinor: number | null; utr: string | null };

/**
 * Applies the first rule that fits. Rules are tried in config order; a rule
 * fits when its sender list (if any) admits the sender and its exclude or
 * match pattern hits.
 *
 * A credit is only ever returned with a positive amount and a well-formed
 * UTR. When a rule recognises the message but cannot read one of them, the
 * result is 'unparsed' with the reason, never a credit with a guess in it.
 */
export function parseBankSms(
  sender: string,
  rawBody: string,
  rules: readonly SmsRule[],
  accountLast4: string | null,
): SmsParseResult {
  // Banks split lines and pad unpredictably; rules are written against the
  // collapsed form, which is also what the admin queue shows.
  const body = rawBody.replace(/\s+/g, " ").trim();

  for (const rule of rules) {
    if (rule.senders !== null && !senderMatches(sender, rule.senders)) continue;

    if (rule.exclude?.test(body)) {
      return { status: "not_credit", ruleName: rule.name };
    }
    if (!rule.match.test(body)) continue;

    const amountText = group(rule.amount, body, "amount");
    const amountMinor = amountText === null ? null : rupeesToPaise(amountText);
    if (amountMinor === null) {
      return { status: "unparsed", ruleName: rule.name, note: `Rule "${rule.name}" matched but found no amount` };
    }

    const utrText = group(rule.utr, body, "utr");
    const utr = utrText === null ? null : normaliseUtr(utrText);
    if (utr === null) {
      return { status: "unparsed", ruleName: rule.name, note: `Rule "${rule.name}" matched but found no UTR` };
    }

    const accountHint = rule.account ? group(rule.account, body, "account") : null;
    if (accountLast4 !== null && rule.account !== null) {
      // Only the digits are compared: banks mask as XX1234, *1234, x1234.
      const digits = (accountHint ?? "").replace(/\D/g, "");
      if (!digits.endsWith(accountLast4)) {
        return {
          status: "rejected",
          ruleName: rule.name,
          note:
            accountHint === null
              ? "Could not read which account was credited"
              : `Credited account ${accountHint} is not the configured account`,
          amountMinor,
          utr,
        };
      }
    }

    const payerHint = rule.payer ? group(rule.payer, body, "payer") : null;
    return { status: "credit", ruleName: rule.name, amountMinor, utr, accountHint, payerHint };
  }

  return {
    status: "unparsed",
    ruleName: null,
    note: rules.length === 0 ? "No parse rules are configured yet" : "No rule matched this message",
  };
}

/**
 * Whether the payer an SMS names looks like this buyer, from the profile
 * details they gave. Deliberately strict, because it is used to choose
 * between two orders automatically:
 *   - phone: the payer text holds at least 10 digits (a VPA like
 *     9876543210@ybl) whose last 10 equal the profile's last 10. A masked
 *     number (XXXXXX3210) is not enough.
 *   - name: the payer name, at least 6 letters, equals the profile name or is
 *     the start of it (banks truncate long names).
 */
export function payerHintMatchesProfile(
  payerHint: string | null,
  profile: { phoneNumber: string | null; fullName: string | null },
): boolean {
  if (payerHint === null) return false;

  const hintDigits = payerHint.replace(/\D/g, "");
  const phoneDigits = (profile.phoneNumber ?? "").replace(/\D/g, "");
  if (hintDigits.length >= 10 && phoneDigits.length >= 10 && hintDigits.slice(-10) === phoneDigits.slice(-10)) {
    return true;
  }

  const norm = (text: string): string => text.toUpperCase().replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
  const hintName = norm(payerHint);
  const profileName = norm(profile.fullName ?? "");
  if (hintName.replace(/ /g, "").length >= 6 && profileName !== "") {
    return profileName === hintName || profileName.startsWith(hintName);
  }
  return false;
}
