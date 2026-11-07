import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute } from "../lib/async-route.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { ingestSms } from "../services/upi-payments.service.js";

export const smsWebhookRouter = Router();

/**
 * Constant-time comparison of a presented token with the configured one.
 * Both sides are hashed first so the comparison is over equal-length buffers
 * whatever was sent; a plain === would leak the token through timing.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedToken(req: Request): string | null {
  const auth = req.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  // For forwarder versions whose header field cannot hold an Authorization
  // value. Never a query parameter: URLs end up in access logs.
  return req.get("x-webhook-token")?.trim() || null;
}

/**
 * A millisecond epoch stamp, as the forwarder's %sentStamp% / %receivedStamp%
 * placeholders produce. Accepted as a number or a numeric string, since a
 * template author may quote it.
 */
const stamp = z
  .union([z.number(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? new Date(n) : null;
  });

/**
 * The body the forwarder is configured to send (docs/upi-sms-payments.md).
 * Field names follow the app's default template; anything else in it is
 * ignored. An SMS longer than this is not a bank alert.
 */
const smsPayload = z.object({
  from: z.string().trim().min(1).max(64),
  text: z.string().min(1).max(2000),
  sentStamp: stamp,
  receivedStamp: stamp,
});

/**
 * POST /api/webhooks/sms — bank SMS from the "SMS to URL Forwarder" app on
 * the owner's phone.
 *
 * Off (404) unless SMS_WEBHOOK_TOKEN is set. Authenticated by that shared
 * token, because the app cannot sign requests; it must be served over HTTPS
 * so the token is never sent in the clear.
 *
 * Every SMS that was received and handled answers 200, whatever became of it
 * (not a bank, not a credit, no matching order): none of those improve with
 * a retry. Only a database failure answers 500, so the app retries, and the
 * dedupe key makes the retry harmless.
 *
 * The response never says what was matched. The phone does not need to know,
 * and a stolen token should not become a way to probe orders.
 */
smsWebhookRouter.post(
  "/api/webhooks/sms",
  asyncRoute(async (req: Request, res: Response) => {
    const expected = env.upi.webhookToken;
    if (expected === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const token = presentedToken(req);
    if (token === null || !tokenMatches(token, expected)) {
      // Worth a look if it repeats: a misconfigured phone, or someone guessing.
      logger.warn("sms webhook rejected: bad or missing token", { ip: req.ip });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = smsPayload.safeParse(req.body);
    if (!parsed.success) {
      logger.warn("sms webhook rejected: unexpected body", {
        issues: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
      });
      res.status(400).json({ error: "Expected { from, text, sentStamp?, receivedStamp? }" });
      return;
    }

    try {
      await ingestSms({
        sender: parsed.data.from,
        body: parsed.data.text,
        sentAt: parsed.data.sentStamp,
        receivedAt: parsed.data.receivedStamp,
      });
      res.status(200).json({ received: true });
    } catch (cause) {
      logger.error("sms webhook failed to process", { cause: String(cause) });
      res.status(500).json({ error: "Failed to process SMS" });
    }
  }),
);
