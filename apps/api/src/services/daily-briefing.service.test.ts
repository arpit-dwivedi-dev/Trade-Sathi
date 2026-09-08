import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
const logAppError = vi.fn();

vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: mockFrom },
  callRpc: vi.fn(),
}));
vi.mock("../lib/error-log.js", () => ({ logAppError }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../lib/env.js", () => ({ env: { dailyBriefingRunHourIst: 8 } }));
vi.mock("./watchlist.service.js", () => ({
  getEnabledWatchlistItems: vi.fn(),
  getWatchlistItemForProfile: vi.fn(),
  listProfilesWithEnabledWatchlist: vi.fn(),
}));
vi.mock("./instrument-analysis.service.js", () => ({
  runInstrumentAnalysis: vi.fn(),
}));
vi.mock("../lib/email/daily-briefing-email.js", () => ({
  buildDailyBriefingEmail: vi.fn(),
}));
vi.mock("../lib/email/resend-client.js", () => ({ sendEmail: vi.fn() }));
vi.mock("./analysis-pdf.service.js", () => ({ buildAnalysisPdfAttachment: vi.fn() }));
vi.mock("./market-chart.service.js", () => ({
  todayIsoDate: vi.fn(() => "2026-09-08"),
}));

const { reclaimStrandedDailyBriefingLogs } = await import("./daily-briefing.service.js");

function chainable(result: { data: unknown; error: unknown }) {
  let mode: "select" | "write" = "write";
  const calls: { method: string; args: unknown[] }[] = [];
  const builder = {
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      mode = "select";
      return builder;
    },
    update: (...args: unknown[]) => {
      calls.push({ method: "update", args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      calls.push({ method: "eq", args });
      return builder;
    },
    lt: (...args: unknown[]) => {
      calls.push({ method: "lt", args });
      return builder;
    },
    order: (...args: unknown[]) => {
      calls.push({ method: "order", args });
      return builder;
    },
    limit: (...args: unknown[]) => {
      calls.push({ method: "limit", args });
      return builder;
    },
    returns: () => builder,
    then: (resolve: (value: unknown) => void) => {
      resolve(mode === "select" ? result : { error: null });
    },
  };
  return { builder, calls };
}

beforeEach(() => {
  mockFrom.mockReset();
  logAppError.mockReset();
});

describe("reclaimStrandedDailyBriefingLogs", () => {
  it("marks old processing rows failed and records the interruption", async () => {
    const row = {
      id: "log-1",
      profile_id: "profile-1",
      briefing_date: "2026-09-08",
      run_hour_ist: 8,
      run_minute_ist: 0,
      created_at: "2026-09-08T00:00:00.000Z",
    };
    const query = chainable({ data: [row], error: null });
    const update = chainable({ data: null, error: null });
    mockFrom.mockReturnValueOnce(query.builder).mockReturnValueOnce(update.builder);

    await expect(reclaimStrandedDailyBriefingLogs()).resolves.toBe(1);

    expect(query.calls).toContainEqual({ method: "eq", args: ["status", "processing"] });
    expect(query.calls).toContainEqual({ method: "lt", args: ["created_at", expect.any(String)] });
    const updatePayload = update.calls.find((call) => call.method === "update")?.args[0];
    expect(updatePayload).toBeTypeOf("object");
    if (updatePayload && typeof updatePayload === "object") {
      const payload = updatePayload as { status?: unknown; updated_at?: unknown };
      expect(payload.status).toBe("failed");
      expect(payload.updated_at).toBeTypeOf("string");
    }
    expect(update.calls).toContainEqual({ method: "eq", args: ["id", "log-1"] });
    expect(update.calls).toContainEqual({ method: "eq", args: ["status", "processing"] });
    expect(logAppError).toHaveBeenCalledWith(
      "profile-1",
      "briefing",
      "The daily briefing was interrupted and could not be completed",
      expect.objectContaining({ briefingLogId: "log-1" }),
    );
  });

  it("does nothing when no processing log is old enough", async () => {
    const query = chainable({ data: [], error: null });
    mockFrom.mockReturnValue(query.builder);

    await expect(reclaimStrandedDailyBriefingLogs()).resolves.toBe(0);
    expect(logAppError).not.toHaveBeenCalled();
  });
});
