import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { detectTxInput } from "../lib/tx-input.ts";

// A tiny wire-format-shaped payload: 1 signature slot of zeros, then message bytes.
const bytes = Uint8Array.from([1, ...new Array<number>(64).fill(0), 128, 1, 0, 1, 3, ...Array.from({ length: 96 }, (_, i) => i)]);
const b64 = Buffer.from(bytes).toString("base64");
const b58 = bs58.encode(bytes);

describe("detectTxInput", () => {
  it("returns null for empty or whitespace input", () => {
    expect(detectTxInput("")).toBeNull();
    expect(detectTxInput("  \n\t ")).toBeNull();
  });

  it("detects base64 and counts decoded bytes", () => {
    expect(detectTxInput(b64)).toEqual({ encoding: "base64", bytes: bytes.length, reason: null });
  });

  it("accounts for base64 padding", () => {
    expect(detectTxInput("AQID")).toMatchObject({ encoding: "base64", bytes: 3 });
    expect(detectTxInput("AQI=")).toMatchObject({ encoding: "base64", bytes: 2 });
    expect(detectTxInput("AQ==")).toMatchObject({ encoding: "base64", bytes: 1 });
  });

  it("detects base58 and counts decoded bytes", () => {
    expect(detectTxInput(b58)).toEqual({ encoding: "base58", bytes: bytes.length, reason: null });
  });

  it("ignores whitespace and line breaks from wrapped pastes", () => {
    const wrapped = `${b64.slice(0, 40)}\n  ${b64.slice(40)} `;
    expect(detectTxInput(wrapped)).toMatchObject({ encoding: "base64", bytes: bytes.length });
    expect(detectTxInput(`${b58.slice(0, 30)}\n${b58.slice(30)}`)).toMatchObject({ encoding: "base58", bytes: bytes.length });
  });

  it("reports base64 with a bad length as unknown", () => {
    expect(detectTxInput(b64.slice(0, -1))).toMatchObject({ encoding: "unknown", bytes: null, reason: expect.stringMatching(/multiple of 4/) });
  });

  it("reports foreign characters as unknown", () => {
    expect(detectTxInput("not a transaction!")).toMatchObject({ encoding: "unknown", bytes: null });
    expect(detectTxInput("abc-def_ghi")).toMatchObject({ encoding: "unknown" });
  });
});
