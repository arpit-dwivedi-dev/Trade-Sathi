import WebSocket from "ws";

import { logger } from "../logger.js";
import { frameToString } from "../ws-frame.js";
import { decodeYahooTick, unwrapStreamFrame, type YahooTick } from "./yahoo-stream-decoder.js";

/**
 * One process-wide connection to Yahoo Finance's streaming socket, shared by
 * every browser watching a live chart.
 *
 * Shared for the same reason the candle cache in market-chart.service is:
 * without it, ten people watching the same symbol would open ten upstream
 * sockets to a free, unofficial, rate-limited endpoint. Subscriptions are
 * reference-counted per symbol, so the upstream subscription list is exactly
 * the union of what is actually on screen right now.
 *
 * Unofficial and undocumented, like the REST chart endpoint — so this never
 * throws upward. A dropped connection reconnects with backoff and the live
 * chart falls back to its REST poll in the meantime.
 */

const YAHOO_STREAM_URL = "wss://streamer.finance.yahoo.com/?version=2";

/** Backoff between reconnects, doubling from the first to a ceiling. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Yahoo drops idle sockets; a ping well inside that keeps it open. */
const HEARTBEAT_MS = 15_000;

export type TickListener = (tick: YahooTick) => void;

type ConnectionState = "idle" | "connecting" | "open";

interface SymbolSubscription {
  listeners: Set<TickListener>;
}

class YahooTickerStream {
  private socket: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly subscriptions = new Map<string, SymbolSubscription>();

  /** True while the upstream socket is connected — surfaced to clients. */
  get connected(): boolean {
    return this.state === "open";
  }

  /**
   * Starts delivering ticks for `symbol` to `listener`. Returns the
   * unsubscribe function; the caller must always call it (on disconnect,
   * on symbol change) or the upstream subscription leaks.
   */
  subscribe(symbol: string, listener: TickListener): () => void {
    let entry = this.subscriptions.get(symbol);
    if (!entry) {
      entry = { listeners: new Set() };
      this.subscriptions.set(symbol, entry);
      this.sendSubscribe([symbol]);
    }
    entry.listeners.add(listener);
    this.ensureConnected();

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const current = this.subscriptions.get(symbol);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;

      this.subscriptions.delete(symbol);
      this.sendUnsubscribe([symbol]);
      // Nothing left to watch: hold no socket open against an idle app.
      if (this.subscriptions.size === 0) this.disconnect();
    };
  }

  private ensureConnected(): void {
    if (this.state !== "idle" || this.subscriptions.size === 0) return;
    this.openSocket();
  }

  private openSocket(): void {
    this.state = "connecting";

    let socket: WebSocket;
    try {
      socket = new WebSocket(YAHOO_STREAM_URL, {
        // Same rationale as the REST provider: Yahoo rejects a fraction of
        // requests with no User-Agent at all.
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeSathi/1.0)" },
      });
    } catch (cause) {
      logger.error("yahoo stream socket could not be created", { cause: String(cause) });
      this.state = "idle";
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.state = "open";
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      logger.info("yahoo stream connected", { symbols: this.subscriptions.size });
      // Resubscribe from scratch: a reconnect is a brand-new session
      // upstream, and symbols may have changed while it was down.
      const symbols = [...this.subscriptions.keys()];
      if (symbols.length > 0) this.sendSubscribe(symbols);
      this.startHeartbeat();
    });

    socket.on("message", (data: WebSocket.RawData) => {
      if (this.socket !== socket) return;
      this.handleFrame(frameToString(data));
    });

    socket.on("error", (cause) => {
      if (this.socket !== socket) return;
      logger.error("yahoo stream socket error", { cause: String(cause) });
      // 'close' always follows 'error'; reconnect is handled there so a
      // single failure cannot schedule two reconnects.
    });

    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.state = "idle";
      this.stopHeartbeat();
      if (this.subscriptions.size > 0) this.scheduleReconnect();
    });
  }

  private handleFrame(frame: string): void {
    const payload = unwrapStreamFrame(frame);
    if (!payload) return;

    const tick = decodeYahooTick(payload);
    if (!tick) return;

    const entry = this.subscriptions.get(tick.symbol);
    if (!entry) return;

    for (const listener of entry.listeners) {
      try {
        listener(tick);
      } catch (cause) {
        // One client's send failing must not stop the other clients watching
        // the same symbol from getting this tick.
        logger.error("yahoo stream listener threw", { cause: String(cause) });
      }
    }
  }

  private sendSubscribe(symbols: string[]): void {
    this.send({ subscribe: symbols });
  }

  private sendUnsubscribe(symbols: string[]): void {
    this.send({ unsubscribe: symbols });
  }

  private send(message: Record<string, string[]>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (cause) {
      logger.error("yahoo stream send failed", { cause: String(cause) });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.ping();
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
    logger.info("yahoo stream reconnecting", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.reconnectDelayMs = RECONNECT_BASE_MS;

    const socket = this.socket;
    this.socket = null;
    this.state = "idle";
    socket?.close();
  }
}

export const yahooTickerStream = new YahooTickerStream();
export type { YahooTick };
