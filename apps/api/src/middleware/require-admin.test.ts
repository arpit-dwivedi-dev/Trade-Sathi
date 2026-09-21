import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

/** Loads env.ts against a clean, fully-populated environment. */
async function loadEnv(adminIds: string | undefined) {
  vi.resetModules();
  // Production skips reading apps/api/.env, whose own ADMIN_USER_IDS would
  // otherwise leak into the "missing" case.
  vi.stubEnv("NODE_ENV", "production");
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "RESEND_FROM_ADDRESS",
    "INTERNAL_OPS_TOKEN",
  ]) {
    vi.stubEnv(name, "x");
  }
  vi.stubEnv(
    "AI_PROVIDERS",
    JSON.stringify([
      { baseUrl: "x", apiKey: "x", model: "x", inputCostPerM: 0, outputCostPerM: 0, maxTokens: 1 },
    ]),
  );
  vi.stubEnv("ADMIN_USER_IDS", adminIds);
  return import("./require-admin.js");
}

function run(requireAdmin: (req: Request, res: Response, next: NextFunction) => void, profileId?: string) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  requireAdmin({ profileId } as Request, res as unknown as Response, next);
  return { res, next };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAdmin", () => {
  it("lets a listed user id through", async () => {
    const { requireAdmin } = await loadEnv(` ${USER}x, ${ADMIN} ,`);
    const { next, res } = run(requireAdmin, ADMIN);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("answers 404 for a signed-in non-admin", async () => {
    const { requireAdmin } = await loadEnv(ADMIN);
    const { next, res } = run(requireAdmin, USER);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("answers 404 when requireAuth set no identity", async () => {
    const { requireAdmin } = await loadEnv(ADMIN);
    expect(run(requireAdmin, undefined).next).not.toHaveBeenCalled();
  });

  it("disables admin entirely when ADMIN_USER_IDS is missing", async () => {
    const { requireAdmin, isAdmin } = await loadEnv(undefined);
    expect(run(requireAdmin, ADMIN).next).not.toHaveBeenCalled();
    expect(isAdmin(ADMIN)).toBe(false);
  });

  it("disables admin entirely when ADMIN_USER_IDS is blank", async () => {
    const { isAdmin } = await loadEnv(" , ");
    expect(isAdmin("")).toBe(false);
    expect(isAdmin(ADMIN)).toBe(false);
  });
});
