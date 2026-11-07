import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "a".repeat(48);

const config = vi.hoisted(() => ({ env: { upi: { webhookToken: null as string | null } } }));
vi.mock("../lib/env.js", () => config);
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const service = vi.hoisted(() => ({
  ingestSms: vi.fn(() => Promise.resolve({ outcome: "matched", smsId: "sms-1" })),
}));
vi.mock("../services/upi-payments.service.js", () => service);

const { smsWebhookRouter, tokenMatches } = await import("./sms-webhook.route.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(smsWebhookRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  config.env.upi.webhookToken = TOKEN;
  service.ingestSms.mockClear();
});

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return fetch(`${base}/api/webhooks/sms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const PAYLOAD = {
  from: "AX-XMPLBK",
  text: "an invented bank message",
  sentStamp: 1794045540000,
  receivedStamp: "1794045541000",
  sim: "sim1",
};

describe("POST /api/webhooks/sms", () => {
  it("does not exist until a token is configured", async () => {
    config.env.upi.webhookToken = null;
    expect((await post(PAYLOAD)).status).toBe(404);
    expect(service.ingestSms).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", {}],
    ["a wrong token", { authorization: `Bearer ${"b".repeat(48)}` }],
    ["a token prefix", { authorization: `Bearer ${TOKEN.slice(0, 10)}` }],
    ["a non-bearer scheme", { authorization: `Basic ${TOKEN}` }],
  ])("refuses %s with a 401", async (_why, headers) => {
    expect((await post(PAYLOAD, headers)).status).toBe(401);
    expect(service.ingestSms).not.toHaveBeenCalled();
  });

  it("accepts the token in X-Webhook-Token too", async () => {
    expect((await post(PAYLOAD, { "x-webhook-token": TOKEN })).status).toBe(200);
  });

  it("hands the SMS to the service, with the stamps as dates", async () => {
    const res = await post(PAYLOAD);
    expect(res.status).toBe(200);
    // Says nothing about what was matched.
    expect(await res.json()).toEqual({ received: true });
    expect(service.ingestSms).toHaveBeenCalledWith({
      sender: "AX-XMPLBK",
      body: "an invented bank message",
      sentAt: new Date(1794045540000),
      receivedAt: new Date(1794045541000),
    });
  });

  it("tolerates missing stamps", async () => {
    await post({ from: "AX-XMPLBK", text: "hello" });
    expect(service.ingestSms).toHaveBeenCalledWith(expect.objectContaining({ sentAt: null, receivedAt: null }));
  });

  it.each([
    ["no sender", { text: "x" }],
    ["no text", { from: "AX-XMPLBK" }],
    ["an oversized text", { from: "AX-XMPLBK", text: "x".repeat(2001) }],
  ])("refuses a body with %s with a 400", async (_why, body) => {
    expect((await post(body)).status).toBe(400);
    expect(service.ingestSms).not.toHaveBeenCalled();
  });

  it("answers a processing failure with a 500 so the forwarder retries", async () => {
    service.ingestSms.mockRejectedValueOnce(new Error("db down"));
    expect((await post(PAYLOAD)).status).toBe(500);
  });
});

describe("tokenMatches", () => {
  it("compares whole tokens", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
  });
});
