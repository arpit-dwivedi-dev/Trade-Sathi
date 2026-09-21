import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/require-admin.js";
import { parseRange } from "../services/admin-metrics.js";
import {
  getActivity,
  getEconomics,
  getHealth,
  getOverview,
  getPayments,
  getUserDetail,
  listUsers,
  type PageParams,
} from "../services/admin.service.js";

/**
 * The read-only Admin panel API. Every path under /api/admin passes
 * requireAuth then requireAdmin before any handler runs — mounted once here so
 * a new endpoint cannot be added without the gate.
 */
export const adminRouter = Router();

adminRouter.use("/api/admin", asyncRoute(requireAuth), requireAdmin);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "string" ? Number(value) : NaN;
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

adminRouter.get(
  "/api/admin/activity",
  adminRead("activity", (req) => getActivity(parseRange(req.query["range"]))),
);

adminRouter.get(
  "/api/admin/health",
  adminRead("health", (req) => getHealth(pageParams(req))),
);
