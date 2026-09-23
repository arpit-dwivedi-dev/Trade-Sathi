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

const CODE_ID = "33333333-3333-4333-8333-333333333333";

const promo = vi.hoisted(() => ({
  listPromoCodes: vi.fn(() => Promise.resolve({ rows: [], total: 0, limit: 25, offset: 0 })),
  createPromoCode: vi.fn((input: { code: string | null }) =>
    Promise.resolve(
      input.code === "TAKEN"
        ? { ok: false, reason: "code_taken" }
        : { ok: true, row: { code: input.code ?? "TS-GENERATED" }, accountExists: null },
    ),
  ),
  setPromoCodeActive: vi.fn((id: string) =>
    Promise.resolve(id === "33333333-3333-4333-8333-333333333333"),
  ),
}));
vi.mock("../services/admin-promo.service.js", () => promo);

const { adminRouter } = await import("./admin.route.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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

function send(method: "POST" | "PUT", path: string, body: unknown, user?: string) {
  return fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: JSON.stringify(body),
  });
}

const ENDPOINTS = [
  "/api/admin/overview",
  "/api/admin/economics",
  "/api/admin/payments",
  "/api/admin/users",
  `/api/admin/users/${ADMIN}`,
  "/api/admin/activity",
  "/api/admin/health",
  "/api/admin/promo-codes",
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

describe("admin promo codes", () => {
  it("keeps the writes behind the admin gate", async () => {
    expect((await send("POST", "/api/admin/promo-codes", { credits: 5 }, USER)).status).toBe(404);
    expect((await send("POST", "/api/admin/promo-codes", { credits: 5 })).status).toBe(401);
    const put = `/api/admin/promo-codes/${CODE_ID}/active`;
    expect((await send("PUT", put, { active: false }, USER)).status).toBe(404);
    expect((await send("PUT", put, { active: false })).status).toBe(401);
  });

  it("normalizes a valid body before creating", async () => {
    const res = await send(
      "POST",
      "/api/admin/promo-codes",
      { code: " vip10 ", credits: 10, email: " Friend@Example.COM ", perUserLimit: 2 },
      ADMIN,
    );
    expect(res.status).toBe(201);
    expect(promo.createPromoCode).toHaveBeenLastCalledWith({
      code: "VIP10",
      credits: 10,
      email: "friend@example.com",
      maxRedemptions: null,
      perUserLimit: 2,
      expiresAt: null,
    });
  });

  it("leaves a blank code to the service to generate", async () => {
    const res = await send(
      "POST",
      "/api/admin/promo-codes",
      { code: "", credits: 5, maxRedemptions: 100 },
      ADMIN,
    );
    expect(res.status).toBe(201);
    expect(promo.createPromoCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: null, email: null, maxRedemptions: 100, perUserLimit: 1 }),
    );
  });

  it.each([
    { why: "no credits", body: {} },
    { why: "zero credits", body: { credits: 0 } },
    { why: "fractional credits", body: { credits: 2.5 } },
    { why: "a code with a space", body: { credits: 5, code: "a b" } },
    { why: "a malformed email", body: { credits: 5, email: "not-an-email" } },
    { why: "a zero cap", body: { credits: 5, maxRedemptions: 0 } },
    { why: "too many uses per account", body: { credits: 5, perUserLimit: 101 } },
    { why: "an expiry in the past", body: { credits: 5, expiresAt: "2001-01-01T00:00:00Z" } },
  ])("rejects a body with $why with a 400", async ({ body }) => {
    const calls = promo.createPromoCode.mock.calls.length;
    const res = await send("POST", "/api/admin/promo-codes", body, ADMIN);
    expect(res.status).toBe(400);
    expect(promo.createPromoCode.mock.calls.length).toBe(calls);
  });

  it("answers a taken code with a 409", async () => {
    const res = await send("POST", "/api/admin/promo-codes", { code: "taken", credits: 5 }, ADMIN);
    expect(res.status).toBe(409);
  });

  it("switches a code on and off, and 404s one that does not exist", async () => {
    const ok = await send("PUT", `/api/admin/promo-codes/${CODE_ID}/active`, { active: false }, ADMIN);
    expect(ok.status).toBe(200);
    expect(promo.setPromoCodeActive).toHaveBeenLastCalledWith(CODE_ID, false);

    expect((await send("PUT", `/api/admin/promo-codes/${USER}/active`, { active: true }, ADMIN)).status).toBe(404);
    expect((await send("PUT", "/api/admin/promo-codes/nope/active", { active: true }, ADMIN)).status).toBe(404);
    expect((await send("PUT", `/api/admin/promo-codes/${CODE_ID}/active`, { active: "yes" }, ADMIN)).status).toBe(400);
  });
});
