import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import type {
  MarketStreamClientMessage,
  MarketStreamServerMessage,
} from "@chartanalyzer/shared";
import { logger } from "../lib/logger.js";
import { frameToString } from "../lib/ws-frame.js";
import { yahooTickerStream } from "../lib/market-data/yahoo-stream.js";
import { verifyAccessToken } from "../middleware/auth.js";
import { fetchInstrumentById } from "../services/market-chart.service.js";

/**
 * The live market-data socket: `/api/market/stream`.
 *
 * Streaming is proxied here for the same reasons the REST candle reads are
 * (routes/market.route.ts) — the provider is server-side only and one shared
 * upstream connection serves every viewer — plus one that is specific to
 * streaming: the browser must never learn which third-party endpoint the
 * prices come from, and a per-symbol upstream subscription per browser tab
 * would exhaust a free endpoint's tolerance immediately.
 *
 * Thin, like the HTTP routes next to it: parse a frame, check auth, delegate.
 * The connection management and protobuf decoding live in
 * lib/market-data/yahoo-stream.
 */

export const MARKET_STREAM_PATH = "/api/market/stream";

/** A socket that has not authenticated within this window is closed. */
const AUTH_TIMEOUT_MS = 10_000;
/** Detects half-open connections (laptop lid closed, network dropped). */
const CLIENT_HEARTBEAT_MS = 30_000;

/** Application close code, in the WebSocket spec's private range. */
const CLOSE_UNAUTHORIZED = 4001;

interface Session {
  profileId: string | null;
  /** Releases the current instrument's upstream subscription, if any. */
  release: (() => void) | null;
  alive: boolean;
}

function send(socket: WebSocket, message: MarketStreamServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function sendError(
  socket: WebSocket,
  code: "unauthorized" | "not_found" | "bad_request",
  message: string,
): void {
  send(socket, { type: "error", code, message });
}

/**
 * Parses a client frame. Returns null for anything that is not a message this
 * protocol defines — an unknown frame is answered with an error, never acted
 * on speculatively.
 */
function parseClientMessage(raw: string): MarketStreamClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const message = parsed as Record<string, unknown>;
  switch (message["type"]) {
    case "auth":
      return typeof message["token"] === "string" ? { type: "auth", token: message["token"] } : null;
    case "subscribe":
      return typeof message["instrumentId"] === "string"
        ? { type: "subscribe", instrumentId: message["instrumentId"] }
        : null;
    case "unsubscribe":
      return { type: "unsubscribe" };
    default:
      return null;
  }
}

async function handleSubscribe(
  socket: WebSocket,
  session: Session,
  instrumentId: string,
): Promise<void> {
  // One instrument per connection: the live view shows one chart, and letting
  // a client accumulate subscriptions would let it fan out the upstream
  // subscription list without bound.
  session.release?.();
  session.release = null;

  const ref = await fetchInstrumentById(instrumentId);
  if (!ref) {
    sendError(socket, "not_found", "Instrument not available for live prices");
    return;
  }

  const release = yahooTickerStream.subscribe(ref.instrumentKey, (tick) => {
    send(socket, {
      type: "tick",
      tick: { instrumentId: ref.instrumentId, price: tick.price, time: tick.time },
    });
  });

  // The socket can close while fetchInstrumentById is in flight; without this
  // the subscription it just took would never be released.
  if (socket.readyState !== socket.OPEN) {
    release();
    return;
  }

  session.release = release;
  send(socket, { type: "subscribed", instrumentId: ref.instrumentId });
}

async function handleMessage(socket: WebSocket, session: Session, raw: string): Promise<void> {
  const message = parseClientMessage(raw);
  if (!message) {
    sendError(socket, "bad_request", "Unrecognised message");
    return;
  }

  if (message.type === "auth") {
    const profileId = await verifyAccessToken(message.token);
    if (!profileId) {
      sendError(socket, "unauthorized", "Invalid or expired token");
      socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    session.profileId = profileId;
    send(socket, { type: "ready" });
    return;
  }

  // Everything past auth requires it. Market data is not per-profile, but an
  // unauthenticated socket is still an anonymous handle on the upstream
  // provider's rate limit.
  if (!session.profileId) {
    sendError(socket, "unauthorized", "Authenticate before subscribing");
    socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
    return;
  }

  if (message.type === "subscribe") {
    await handleSubscribe(socket, session, message.instrumentId);
    return;
  }

  session.release?.();
  session.release = null;
}

/**
 * Attaches the market stream to the HTTP server. Uses `noServer` and an
 * explicit upgrade handler so only this one path is upgraded — any other
 * upgrade request is refused rather than silently accepted.
 */
export function attachMarketStream(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    // `request.url` is path+query only; a base is needed to parse it, and is
    // never used for anything else.
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== MARKET_STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (socket: WebSocket) => {
    const session: Session = { profileId: null, release: null, alive: true };

    const authTimer = setTimeout(() => {
      if (session.profileId) return;
      sendError(socket, "unauthorized", "Authentication timed out");
      socket.close(CLOSE_UNAUTHORIZED, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (data) => {
      void handleMessage(socket, session, frameToString(data)).catch((cause) => {
        logger.error("market stream message failed", { cause: String(cause) });
        sendError(socket, "bad_request", "Could not handle that message");
      });
    });

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("error", (cause) => {
      logger.error("market stream client socket error", { cause: String(cause) });
    });

    // Half-open connections (a closed laptop, a dropped network) never fire
    // 'close', so they would hold their upstream subscription forever. A
    // ping that goes unanswered for one interval closes the socket, which
    // then runs the cleanup below.
    const heartbeat = setInterval(() => {
      if (!session.alive) {
        socket.terminate();
        return;
      }
      session.alive = false;
      socket.ping();
    }, CLIENT_HEARTBEAT_MS);

    socket.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      session.release?.();
      session.release = null;
    });
  });

  logger.info("market stream attached", { path: MARKET_STREAM_PATH });
}
