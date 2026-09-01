import { describe, expect, it } from "vitest";

import { decodeYahooTick, unwrapStreamFrame } from "./yahoo-stream-decoder.js";

/**
 * The decoder is hand-written against Yahoo's undocumented `PricingData`
 * message, so these tests build real protobuf bytes with an independent
 * encoder rather than round-tripping the decoder against itself.
 */

function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function tag(field: number, wireType: number): Buffer {
  return varint(BigInt((field << 3) | wireType));
}

function zigzag(value: number): bigint {
  const v = BigInt(value);
  return (v << 1n) ^ (v >> 63n);
}

function stringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([tag(field, 2), varint(BigInt(bytes.length)), bytes]);
}

function floatField(field: number, value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value);
  return Buffer.concat([tag(field, 5), bytes]);
}

function sint64Field(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(zigzag(value))]);
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(BigInt(value))]);
}

function fixed64Field(field: number, value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return Buffer.concat([tag(field, 1), bytes]);
}

function encode(parts: Buffer[]): string {
  return Buffer.concat(parts).toString("base64");
}

describe("decodeYahooTick", () => {
  it("decodes the fields the live chart uses", () => {
    const payload = encode([
      stringField(1, "RELIANCE.NS"),
      floatField(2, 1234.5),
      sint64Field(3, 1_756_712_400_000),
      varintField(7, 1),
      sint64Field(9, 4_500_000),
      floatField(10, 1250),
      floatField(11, 1201.25),
    ]);

    expect(decodeYahooTick(payload)).toEqual({
      symbol: "RELIANCE.NS",
      price: 1234.5,
      time: 1_756_712_400_000,
      dayHigh: 1250,
      dayLow: 1201.25,
      dayVolume: 4_500_000,
      session: "regular",
    });
  });

  it("skips fields it does not know, whatever their wire type", () => {
    const payload = encode([
      stringField(1, "TCS.NS"),
      // A string, a float, a varint and a fixed64 in fields this decoder
      // ignores — each has to be stepped over by its own wire type.
      stringField(13, "Tata Consultancy Services"),
      floatField(12, -3.5),
      varintField(6, 8),
      fixed64Field(30, 42n),
      floatField(2, 3100.75),
    ]);

    const tick = decodeYahooTick(payload);
    expect(tick?.symbol).toBe("TCS.NS");
    expect(tick?.price).toBeCloseTo(3100.75, 2);
  });

  it("leaves absent optional fields null", () => {
    const payload = encode([stringField(1, "INFY.NS"), floatField(2, 1500)]);

    const tick = decodeYahooTick(payload);
    expect(tick?.dayHigh).toBeNull();
    expect(tick?.dayLow).toBeNull();
    expect(tick?.dayVolume).toBeNull();
    expect(tick?.session).toBeNull();
  });

  it("falls back to arrival time when the frame carries no timestamp", () => {
    const before = Date.now();
    const tick = decodeYahooTick(encode([stringField(1, "SBIN.NS"), floatField(2, 800)]));

    expect(tick?.time).toBeGreaterThanOrEqual(before);
    expect(tick?.time).toBeLessThanOrEqual(Date.now());
  });

  it("returns null rather than throwing on unusable payloads", () => {
    // No symbol, no price, truncated mid-field, and outright garbage — a bad
    // frame must be dropped, never take the shared connection down.
    expect(decodeYahooTick(encode([floatField(2, 100)]))).toBeNull();
    expect(decodeYahooTick(encode([stringField(1, "SBIN.NS")]))).toBeNull();
    expect(decodeYahooTick(Buffer.from([0x0a, 0x20, 0x41]).toString("base64"))).toBeNull();
    expect(decodeYahooTick("!!!not base64!!!")).toBeNull();
    expect(decodeYahooTick("")).toBeNull();
  });
});

describe("unwrapStreamFrame", () => {
  it("unwraps the version=2 JSON envelope", () => {
    expect(unwrapStreamFrame('{"type":"pricing","message":"QUJD"}')).toBe("QUJD");
  });

  it("passes a bare base64 frame through", () => {
    expect(unwrapStreamFrame("QUJD")).toBe("QUJD");
  });

  it("returns null for frames with no payload", () => {
    expect(unwrapStreamFrame('{"type":"pricing"}')).toBeNull();
    expect(unwrapStreamFrame('{"message":123}')).toBeNull();
    expect(unwrapStreamFrame("{not json")).toBeNull();
    expect(unwrapStreamFrame("   ")).toBeNull();
  });
});
