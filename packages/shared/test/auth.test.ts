import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  buildLoginMessage,
  nonceResponseSchema,
  parseLoginMessage,
  verifyRequestSchema,
} from "../src/auth.ts";

const nonce = "4vJ9JU1bJJE96FWSJKvHsm";
const issued = "2026-10-13T12:00:00.000Z";

describe("buildLoginMessage", () => {
  it("builds the exact message the wallet signs", () => {
    expect(buildLoginMessage(nonce, issued)).toBe(
      `SolTracer login\nNonce: ${nonce}\nIssued: ${issued}`,
    );
  });
});

describe("parseLoginMessage", () => {
  it("round-trips a built message", () => {
    expect(parseLoginMessage(buildLoginMessage(nonce, issued))).toEqual({ nonce, issued });
  });

  it("rejects a wrong header, extra lines or a bad timestamp", () => {
    expect(parseLoginMessage(`Other login\nNonce: ${nonce}\nIssued: ${issued}`)).toBeNull();
    expect(parseLoginMessage(`${buildLoginMessage(nonce, issued)}\nExtra: 1`)).toBeNull();
    expect(parseLoginMessage(`SolTracer login\nNonce: ${nonce}\nIssued: yesterday`)).toBeNull();
    expect(parseLoginMessage(`SolTracer login\nNonce: \nIssued: ${issued}`)).toBeNull();
    expect(parseLoginMessage(`SolTracer login\nNonce: not-base58!\nIssued: ${issued}`)).toBeNull();
  });
});

describe("verifyRequestSchema", () => {
  const valid = {
    publicKey: bs58.encode(new Uint8Array(32).fill(3)),
    signature: bs58.encode(new Uint8Array(64).fill(4)),
    message: buildLoginMessage(nonce, issued),
  };

  it("accepts a well-formed request", () => {
    expect(verifyRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an oversized message and unknown keys", () => {
    expect(verifyRequestSchema.safeParse({ ...valid, message: "x".repeat(513) }).success).toBe(false);
    expect(verifyRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("nonceResponseSchema", () => {
  it("requires ISO timestamps", () => {
    expect(
      nonceResponseSchema.safeParse({ ok: true, nonce, issuedAt: issued, expiresAt: issued }).success,
    ).toBe(true);
    expect(
      nonceResponseSchema.safeParse({ ok: true, nonce, issuedAt: "now", expiresAt: issued }).success,
    ).toBe(false);
  });
});
