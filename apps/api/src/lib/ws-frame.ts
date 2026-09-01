import type { RawData } from "ws";

/**
 * Decodes a WebSocket frame's payload as UTF-8 text.
 *
 * `ws` hands a frame over as a Buffer, an ArrayBuffer, or an array of Buffers
 * (a fragmented message), and a bare `.toString()` produces "[object
 * ArrayBuffer]" for the middle case and a comma-joined mess for the last.
 * Both ends of the live market stream — the upstream Yahoo socket and the
 * browser sockets — read text frames, so they share this.
 */
export function frameToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
