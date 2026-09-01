/**
 * Decoder for the frames Yahoo Finance's streaming socket pushes.
 *
 * The socket carries protobuf-encoded `PricingData` messages, base64'd inside
 * a JSON envelope. That is one message with a handful of scalar fields, so it
 * is decoded here by hand rather than by adding protobufjs plus a .proto file
 * to the API: a generic protobuf runtime would be a dependency (and a build
 * step) bought for a single message shape.
 *
 * The wire format is self-describing enough for this to be safe — every field
 * carries its own wire type, so unknown/new fields are skipped correctly
 * rather than misread. Same posture as the REST provider next door: Yahoo's
 * streamer is unofficial and undocumented, so anything that does not decode
 * cleanly is dropped, never guessed at.
 */

/** Field numbers from Yahoo's `PricingData` message. Only what the chart uses. */
const FIELD_ID = 1;
const FIELD_PRICE = 2;
const FIELD_TIME = 3;
const FIELD_MARKET_HOURS = 7;
const FIELD_DAY_VOLUME = 9;
const FIELD_DAY_HIGH = 10;
const FIELD_DAY_LOW = 11;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/** `marketHours` enum values, as Yahoo numbers them. */
export type MarketSession = "pre" | "regular" | "post" | "extended";

const MARKET_SESSIONS: Record<number, MarketSession> = {
  0: "pre",
  1: "regular",
  2: "post",
  3: "extended",
};

/** One price update for one symbol. Fields Yahoo omitted stay null. */
export interface YahooTick {
  /** Yahoo ticker symbol, e.g. "RELIANCE.NS" — matches `instrumentKey`. */
  symbol: string;
  price: number;
  /** Epoch milliseconds, as Yahoo sends it. */
  time: number;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  session: MarketSession | null;
}

/** Cursor over one protobuf message. Throws on a truncated/invalid buffer. */
class Reader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  /**
   * Base-128 varint. Capped at 10 bytes (the maximum encoding of a 64-bit
   * value) so a corrupt buffer cannot spin here, and accumulated as a
   * BigInt because `time` and `dayVolume` are genuinely 64-bit.
   */
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.done) throw new Error("truncated varint");
      const byte = this.buf[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("varint too long");
  }

  /** Zigzag-decoded signed varint — the encoding `sint64` fields use. */
  sint64(): number {
    const raw = this.varint();
    return Number((raw >> 1n) ^ -(raw & 1n));
  }

  float(): number {
    if (this.offset + 4 > this.buf.length) throw new Error("truncated float");
    const value = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(): Buffer {
    const length = Number(this.varint());
    if (length < 0 || this.offset + length > this.buf.length) {
      throw new Error("truncated length-delimited field");
    }
    const slice = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** Advances past a field this decoder does not care about. */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.offset += 8;
        if (this.offset > this.buf.length) throw new Error("truncated fixed64");
        return;
      case WIRE_LENGTH_DELIMITED:
        this.bytes();
        return;
      case WIRE_FIXED32:
        this.offset += 4;
        if (this.offset > this.buf.length) throw new Error("truncated fixed32");
        return;
      default:
        // Wire types 3/4 (deprecated groups) never appear in this message and
        // cannot be skipped without a length; treat as unrecoverable.
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}

/**
 * Decodes one base64 `PricingData` payload. Returns null when the payload is
 * unreadable or carries no usable price — a bad frame is skipped, not thrown,
 * because one malformed tick must not tear down a live connection.
 */
export function decodeYahooTick(base64Payload: string): YahooTick | null {
  let reader: Reader;
  try {
    reader = new Reader(Buffer.from(base64Payload, "base64"));
  } catch {
    return null;
  }

  let symbol: string | null = null;
  let price: number | null = null;
  let time: number | null = null;
  let dayHigh: number | null = null;
  let dayLow: number | null = null;
  let dayVolume: number | null = null;
  let session: MarketSession | null = null;

  try {
    while (!reader.done) {
      const tag = Number(reader.varint());
      const fieldNumber = tag >>> 3;
      const wireType = tag & 0x7;

      // Every branch also checks the wire type: if Yahoo ever renumbers or
      // retypes a field, this reads it as unknown and skips rather than
      // decoding a string as a float.
      if (fieldNumber === FIELD_ID && wireType === WIRE_LENGTH_DELIMITED) {
        symbol = reader.bytes().toString("utf8");
      } else if (fieldNumber === FIELD_PRICE && wireType === WIRE_FIXED32) {
        price = reader.float();
      } else if (fieldNumber === FIELD_TIME && wireType === WIRE_VARINT) {
        time = reader.sint64();
      } else if (fieldNumber === FIELD_MARKET_HOURS && wireType === WIRE_VARINT) {
        session = MARKET_SESSIONS[Number(reader.varint())] ?? null;
      } else if (fieldNumber === FIELD_DAY_VOLUME && wireType === WIRE_VARINT) {
        dayVolume = reader.sint64();
      } else if (fieldNumber === FIELD_DAY_HIGH && wireType === WIRE_FIXED32) {
        dayHigh = reader.float();
      } else if (fieldNumber === FIELD_DAY_LOW && wireType === WIRE_FIXED32) {
        dayLow = reader.float();
      } else {
        reader.skip(wireType);
      }
    }
  } catch {
    return null;
  }

  if (!symbol || price == null || !Number.isFinite(price)) return null;

  return {
    symbol,
    price,
    // Yahoo sends epoch milliseconds. A frame without one is still a valid
    // price, so fall back to arrival time rather than discarding it.
    time: time != null && time > 0 ? time : Date.now(),
    dayHigh: dayHigh != null && Number.isFinite(dayHigh) ? dayHigh : null,
    dayLow: dayLow != null && Number.isFinite(dayLow) ? dayLow : null,
    dayVolume,
    session,
  };
}

/**
 * Unwraps a raw socket frame to its base64 payload. `?version=2` wraps the
 * payload in `{"message": "<base64>"}`; the older endpoint sends the bare
 * base64 string. Both are accepted so a Yahoo-side default flip does not go
 * silently dark.
 */
export function unwrapStreamFrame(frame: string): string | null {
  const trimmed = frame.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
        const { message } = parsed;
        return typeof message === "string" ? message : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  return trimmed;
}
