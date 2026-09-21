import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

// Identity comes from a test header instead of a real JWT; requireAdmin itself
// is the real middleware, reading this mocked env.
vi.mock("../lib/env.js", () => ({ env: { adminUserIds: new Set([ADMIN]) } }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const id = req.get("x-test-user");
    if (!id) {
      res.status(401).json({ error: "Missing or malformed Authorization header" });
      return;
    }
    req.profileId = id;
    next();
  },
}));

const service = vi.hoisted(() => ({
  getOverview: vi.fn((range: string) => Promise.resolve({ range })),
  getEconomics: vi.fn(() => Promise.resolve({ totals: {} })),
  getPayments: vi.fn(() => Promise.resolve({ summary: {} })),
  listUsers: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  getUserDetail: vi.fn((id: string) => Promise.resolve(id === ADMIN ? { user: { id } } : null)),
  getActivity: vi.fn(() => Promise.resolve({ briefings: {} })),
  getHealth: vi.fn(() => Promise.resolve({ errors: { rows: [] } })),
}));
vi.mock("../services/admin.service.js", () => service);

const { adminRouter } = await import("./admin.route.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(adminRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function get(path: string, user?: string) {
  return fetch(base + path, { headers: user ? { "x-test-user": user } : {} });
}

const ENDPOINTS = [
  "/api/admin/overview",
  "/api/admin/economics",
  "/api/admin/payments",
  "/api/admin/users",
  `/api/admin/users/${ADMIN}`,
  "/api/admin/activity",
  "/api/admin/health",
];

describe("admin API", () => {
  it.each(ENDPOINTS)("%s answers an admin with 200 JSON", async (path) => {
    const res = await get(path, ADMIN);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeTypeOf("object");
  });

  it.each(ENDPOINTS)("%s is 404 for a non-admin", async (path) => {
    expect((await get(path, USER)).status).toBe(404);
  });

  it.each(ENDPOINTS)("%s is 401 without a session", async (path) => {
    expect((await get(path)).status).toBe(401);
  });

  it("passes the range and clamps pagination", async () => {
    await get("/api/admin/overview?range=7d", ADMIN);
    expect(service.getOverview).toHaveBeenLastCalledWith("7d");

    await get("/api/admin/economics?limit=5000&offset=-3&source=manual&status=", ADMIN);
    expect(service.getEconomics).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100, offset: 0, source: "manual", status: null, range: "30d" }),
    );
  });

  it("404s an unknown or malformed user id", async () => {
    expect((await get(`/api/admin/users/${USER}`, ADMIN)).status).toBe(404);
    expect((await get("/api/admin/users/not-a-uuid", ADMIN)).status).toBe(404);
  });

  it("answers a service failure with a generic 500", async () => {
    service.getHealth.mockRejectedValueOnce(new Error("db down"));
    const res = await get("/api/admin/health", ADMIN);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load health" });
  });
});
