import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import type {
  MarketStreamClientMessage,
  MarketStreamServerMessage,
  MarketTick,
} from '@tradesathi/shared';

import { AuthService } from './auth.service';

/**
 * The browser end of the live market-data socket (`/api/market/stream`).
 *
 * Holds one socket for the app and lets a caller watch one instrument at a
 * time — which is all the live view ever needs, and matches the one-subscription
 * -per-connection rule the API enforces. The socket connects lazily on the
 * first watch and closes when nothing is being watched, so the page costs
 * nothing until a symbol is picked.
 *
 * Prices arriving here are a live overlay, never the source of truth: the REST
 * candle poll each caller already runs still owns completed candles, so a
 * socket that never connects degrades to exactly the behaviour that existed
 * before it.
 */

/** Reconnect backoff, doubling from the first attempt to a ceiling. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type TickHandler = (tick: MarketTick) => void;

interface Watch {
  instrumentId: string;
  onTick: TickHandler;
}

@Injectable({ providedIn: 'root' })
export class MarketStreamService {
  private readonly auth = inject(AuthService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** True once the API has accepted this session's subscription. */
  readonly streaming = signal(false);

  private socket: WebSocket | null = null;
  private watch: Watch | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a slow connect for an abandoned symbol delivering ticks. */
  private watchSeq = 0;

  /**
   * Starts delivering live prices for `instrumentId`. Replaces any previous
   * watch. Returns a stop function the caller must invoke when the symbol
   * changes or the view is destroyed.
   */
  watchInstrument(instrumentId: string, onTick: TickHandler): () => void {
    if (!this.isBrowser) return () => {};

    const seq = ++this.watchSeq;
    this.watch = { instrumentId, onTick };
    this.streaming.set(false);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', instrumentId });
    } else {
      this.ensureConnected();
    }

    return () => {
      if (seq !== this.watchSeq) return;
      this.watch = null;
      this.streaming.set(false);
      this.disconnect();
    };
  }

  private ensureConnected(): void {
    if (this.socket || this.reconnectTimer || !this.watch) return;

    const url = new URL('/api/market/stream', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      // The token is read at connect time, not cached, so a reconnect after a
      // long disconnect authenticates with a currently-valid one.
      void this.auth.getAccessToken().then((token) => {
        if (this.socket !== socket) return;
        if (!token) {
          socket.close();
          return;
        }
        this.send({ type: 'auth', token });
      });
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.streaming.set(false);
      if (this.watch) this.scheduleReconnect();
    });

    // 'error' is always followed by 'close', which owns the reconnect.
    socket.addEventListener('error', () => {});
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let message: MarketStreamServerMessage;
    try {
      message = JSON.parse(raw) as MarketStreamServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'ready': {
        this.reconnectDelayMs = RECONNECT_BASE_MS;
        const watch = this.watch;
        if (watch) this.send({ type: 'subscribe', instrumentId: watch.instrumentId });
        return;
      }
      case 'subscribed':
        if (this.watch?.instrumentId === message.instrumentId) this.streaming.set(true);
        return;
      case 'tick':
        // A tick for a symbol the caller has already moved off must not paint
        // over the new one — the subscribe and its confirmation race.
        if (this.watch?.instrumentId === message.tick.instrumentId) {
          this.watch.onTick(message.tick);
        }
        return;
      case 'error':
        // Live prices are an enhancement; a failure here is not shown to the
        // user, who still has the polled chart. It is worth a console note.
        console.warn('market stream error', message.code, message.message);
        this.streaming.set(false);
        return;
    }
  }

  private send(message: MarketStreamClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.watch) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
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
    this.reconnectDelayMs = RECONNECT_BASE_MS;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
