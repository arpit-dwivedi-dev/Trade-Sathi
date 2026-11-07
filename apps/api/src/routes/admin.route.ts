import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/require-admin.js";
import { parseRange } from "../services/admin-metrics.js";
import {
  createPromoCode,
  listPromoCodes,
  setPromoCodeActive,
  type PromoCodeInput,
} from "../services/admin-promo.service.js";
import {
  adminIgnoreSms,
  adminMarkUpiPaid,
  adminMatchSms,
  getUpiReview,
  type AdminMarkPaidOutcome,
  type AdminMatchOutcome,
} from "../services/admin-upi.service.js";
import {
  getActivity,
  getEconomics,
  getHealth,
  getOverview,
  getPayments,
  getUserDetail,
  listUsers,
  setUserExcluded,
  type PageParams,
} from "../services/admin.service.js";

/**
 * The Admin panel API — reads, plus three kinds of write: excluding an account
 * from the numbers, managing promo codes, and settling UPI payments by hand. Every path under /api/admin passes
 * requireAuth then requireAdmin before any handler runs — mounted once here so
 * a new endpoint cannot be added without the gate.
 */
export const adminRouter = Router();

adminRouter.use("/api/admin", asyncRoute(requireAuth), requireAdmin);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  // Number("") is 0, so a blank value would otherwise clamp to `min`.
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function pageParams(req: Request): PageParams {
  return {
    limit: intParam(req.query["limit"], DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: intParam(req.query["offset"], 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** A short free-text filter value, or null when absent/blank. */
function textParam(value: unknown, maxLength = 100): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

/** Wraps a read so a failure is logged and answered with one generic 500. */
function adminRead(name: string, read: (req: Request) => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json(await read(req));
    } catch (cause) {
      logger.error(`admin ${name} failed`, { cause: String(cause) });
      res.status(500).json({ error: `Failed to load ${name}` });
    }
  });
}

adminRouter.get(
  "/api/admin/overview",
  adminRead("overview", (req) => getOverview(parseRange(req.query["range"]))),
);

adminRouter.get(
  "/api/admin/economics",
  adminRead("economics", (req) =>
    getEconomics({
      ...pageParams(req),
      range: parseRange(req.query["range"]),
      source: textParam(req.query["source"]),
      model: textParam(req.query["model"]),
      status: textParam(req.query["status"]),
    }),
  ),
);

adminRouter.get(
  "/api/admin/payments",
  adminRead("payments", (req) =>
    getPayments({
      ...pageParams(req),
      range: parseRange(req.query["range"]),
      status: textParam(req.query["status"]),
      currency: textParam(req.query["currency"], 3),
    }),
  ),
);

adminRouter.get(
  "/api/admin/users",
  adminRead("users", (req) =>
    listUsers({ ...pageParams(req), search: textParam(req.query["search"], 200) }),
  ),
);

adminRouter.get(
  "/api/admin/users/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const id = req.params["id"] ?? "";
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    try {
      const detail = await getUserDetail(id);
      if (!detail) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json(detail);
    } catch (cause) {
      logger.error("admin user detail failed", { cause: String(cause) });
      res.status(500).json({ error: "Failed to load user" });
    }
  }),
);

// Include or exclude one account from every total the panel reports.
adminRouter.put(
  "/api/admin/users/:id/excluded",
  asyncRoute(async (req: Request, res: Response) => {
    const id = req.params["id"] ?? "";
    const excluded: unknown = (req.body as { excluded?: unknown } | undefined)?.excluded;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (typeof excluded !== "boolean") {
      res.status(400).json({ error: "excluded must be true or false" });
      return;
    }
    try {
      if (!(await setUserExcluded(id, excluded))) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ excluded });
    } catch (cause) {
      logger.error("admin set excluded failed", { cause: String(cause) });
      res.status(500).json({ error: "Failed to update user" });
    }
  }),
);

adminRouter.get(
  "/api/admin/activity",
  adminRead("activity", (req) => getActivity(parseRange(req.query["range"]))),
);

adminRouter.get(
  "/api/admin/health",
  adminRead("health", (req) => getHealth(pageParams(req))),
);

// ── Promo codes ────────────────────────────────────────────────────────────

/** Stored upper-cased; redemption compares case-insensitively anyway. */
const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PROMO_CREDITS = 1000;
const MAX_PROMO_REDEMPTIONS = 1_000_000;
const MAX_PROMO_PER_USER = 100;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Absent, null and "" all mean "not given" for the optional fields. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** The body of POST /api/admin/promo-codes (AdminPromoCodeCreate), checked and normalized. */
function parsePromoCodeInput(body: unknown): Parsed<PromoCodeInput> {
  const b = (body ?? {}) as Record<string, unknown>;

  let code: string | null = null;
  const rawCode = b["code"];
  if (given(rawCode)) {
    if (typeof rawCode !== "string") return { ok: false, error: "The code must be text" };
    code = rawCode.trim().toUpperCase() || null;
    if (code && !PROMO_CODE_RE.test(code)) {
      return { ok: false, error: "A code is 3 to 32 letters, digits, hyphens or underscores" };
    }
  }

  const credits = b["credits"];
  if (!isIntIn(credits, 1, MAX_PROMO_CREDITS)) {
    return { ok: false, error: `Credits must be a whole number from 1 to ${MAX_PROMO_CREDITS}` };
  }

  let email: string | null = null;
  const rawEmail = b["email"];
  if (given(rawEmail)) {
    const trimmed = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) {
      return { ok: false, error: "That email address does not look right" };
    }
    email = trimmed;
  }

  let maxRedemptions: number | null = null;
  const rawMax = b["maxRedemptions"];
  if (given(rawMax)) {
    if (!isIntIn(rawMax, 1, MAX_PROMO_REDEMPTIONS)) {
      return { ok: false, error: "Total uses must be a whole number of at least 1, or left empty" };
    }
    maxRedemptions = rawMax;
  }

  let perUserLimit = 1;
  const rawPerUser = b["perUserLimit"];
  if (given(rawPerUser)) {
    if (!isIntIn(rawPerUser, 1, MAX_PROMO_PER_USER)) {
      return {
        ok: false,
        error: `Uses per account must be a whole number from 1 to ${MAX_PROMO_PER_USER}`,
      };
    }
    perUserLimit = rawPerUser;
  }

  let expiresAt: string | null = null;
  const rawExpiry = b["expiresAt"];
  if (given(rawExpiry)) {
    const at = typeof rawExpiry === "string" ? Date.parse(rawExpiry) : NaN;
    if (!Number.isFinite(at) || at <= Date.now()) {
      return { ok: false, error: "The expiry must be in the future" };
    }
    expiresAt = new Date(at).toISOString();
  }

  return { ok: true, value: { code, credits, email, maxRedemptions, perUserLimit, expiresAt } };
}

adminRouter.get(
  "/api/admin/promo-codes",
  adminRead("promo codes", (req) => listPromoCodes(pageParams(req))),
);

adminRouter.post(
  "/api/admin/promo-codes",
  asyncRoute(async (req: Request, res: Response) => {
    const parsed = parsePromoCodeInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const result = await createPromoCode(parsed.value);
      if (!result.ok) {
        res.status(409).json({ error: "That code already exists" });
        return;
      }
      res.status(201).json({ row: result.row, accountExists: result.accountExists });
    } catch (cause) {
      logger.error("admin create promo code failed", { cause: String(cause) });
      res.status(500).json({ error: "Failed to create promo code" });
    }
  }),
);

// Switch a code on or off. Off answers every redemption as an unknown code.
adminRouter.put(
  "/api/admin/promo-codes/:id/active",
  asyncRoute(async (req: Request, res: Response) => {
    const id = req.params["id"] ?? "";
    const active: unknown = (req.body as { active?: unknown } | undefined)?.active;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Promo code not found" });
      return;
    }
    if (typeof active !== "boolean") {
      res.status(400).json({ error: "active must be true or false" });
      return;
    }
    try {
      if (!(await setPromoCodeActive(id, active))) {
        res.status(404).json({ error: "Promo code not found" });
        return;
      }
      res.json({ active });
    } catch (cause) {
      logger.error("admin set promo code active failed", { cause: String(cause) });
      res.status(500).json({ error: "Failed to update promo code" });
    }
  }),
);

/* ── UPI payments: the manual-verification queue ── */

/** An optional review note, trimmed; null when absent or blank. */
function noteParam(value: unknown): string | null {
  return textParam(value, 500);
}

adminRouter.get(
  "/api/admin/upi",
  adminRead("upi review", () => getUpiReview()),
);

const MATCH_STATUS: Record<Exclude<AdminMatchOutcome, "matched">, { status: number; error: string }> = {
  sms_not_found: { status: 404, error: "SMS not found" },
  sms_not_credit: { status: 409, error: "That SMS has no amount and UTR to settle with" },
  sms_already_matched: { status: 409, error: "That SMS has already been settled or dismissed" },
  payment_not_found: { status: 404, error: "UPI order not found" },
  payment_already_paid: { status: 409, error: "That order is already paid" },
  amount_mismatch: { status: 409, error: "The SMS amount is not the order amount" },
};

// Settle an order from an SMS: for an unmatched or ambiguous SMS, or one
// rejected by the account check. The amount must still equal the order's.
adminRouter.post(
  "/api/admin/upi/sms/:id/match",
  asyncRoute(async (req: Request, res: Response) => {
    const smsId = req.params["id"] ?? "";
    const body = (req.body ?? {}) as { paymentId?: unknown; note?: unknown };
    if (!UUID_RE.test(smsId)) {
      res.status(404).json({ error: "SMS not found" });
      return;
    }
    if (typeof body.paymentId !== "string" || !UUID_RE.test(body.paymentId)) {
      res.status(400).json({ error: "paymentId must be an order id" });
      return;
    }
    try {
      // Non-null: requireAuth set it before requireAdmin let this through.
      const outcome = await adminMatchSms(smsId, body.paymentId, req.profileId!, noteParam(body.note));
      if (outcome === "matched") {
        res.json({ outcome });
        return;
      }
      const { status, error } = MATCH_STATUS[outcome];
      res.status(status).json({ error, outcome });
    } catch (cause) {
      logger.error("admin upi match failed", { cause: String(cause) });
      res.status(500).json({ error: "Failed to settle the order" });
    }
  }),
);

// Dismiss an SMS: a refund, a personal transfer, an alert that is not a payment.
adminRouter.post(
  "/api/admin/upi/sms/:id/ignore",
  asyncRoute(async (req: Request, res: Response) => {
    const smsId = req.params["id"] ?? "";
    if (!UUID_RE.test(smsId)) {
      res.status(404).json({ error: "SMS not found" });
      return;
    }
    try {
      const ignored = await adminIgnoreSms(
        smsId,
        req.profileId!,
        noteParam((req.body as { note?: unknown } | undefined)?.note),
      );
      if (!ignored) {
        res.status(409).json({ error: "That SMS is gone or has already settled an order" });
        return;
      }
      res.json({ ignored });
    } catch (cause) {
      logger.error("admin upi ignore failed", { cause: String(cause) });
      res.status(500).json({ error: "Failed to dismiss the SMS" });
    }
  }),
);

const MARK_PAID_STATUS: Record<Exclude<AdminMarkPaidOutcome, "applied">, { status: number; error: string }> = {
  payment_not_found: { status: 404, error: "UPI order not found" },
  payment_already_paid: { status: 409, error: "That order is already paid" },
  utr_already_used: { status: 409, error: "That UTR has already settled an order" },
  utr_has_sms: { status: 409, error: "An SMS carries that UTR. Link the SMS instead, which checks its amount." },
};

// Mark an order paid with no SMS, from a UTR checked in the bank statement.
// A note is required: this is the one path with no message from the bank
// behind it, so the audit log has to say why.
adminRouter.post(
  "/api/admin/upi/orders/:id/mark-paid",
  asyncRoute(async (req: Request, res: Response) => {
    const paymentId = req.params["id"] ?? "";
    const body = (req.body ?? {}) as { utr?: unknown; note?: unknown };
    if (!UUID_RE.test(paymentId)) {
      res.status(404).json({ error: "UPI order not found" });
      return;
    }
    const utr = typeof body.utr === "string" ? body.utr.replace(/\s/g, "").toUpperCase() : "";
    if (!/^[A-Z0-9]{6,35}$/.test(utr)) {
      res.status(400).json({ error: "utr must be the 12-digit UPI reference from the bank statement" });
      return;
    }
    const note = noteParam(body.note);
    if (note === null) {
      res.status(400).json({ error: "Say where you checked the payment (a note is required)" });
      return;
    }
    try {
      const outcome = await adminMarkUpiPaid(paymentId, utr, req.profileId!, note);
      if (outcome === "applied") {
        res.json({ outcome });
        return;
      }
      const { status, error } = MARK_PAID_STATUS[outcome];
      res.status(status).json({ error, outcome });
    } catch (cause) {
      logger.error("admin upi mark paid failed", { cause: String(cause) });
      res.status(500).json({ error: "Failed to mark the order paid" });
    }
  }),
);
