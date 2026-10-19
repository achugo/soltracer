import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  buildLoginMessage,
  engineVerifyRequestSchema,
  hostSchema,
  nonceResponseSchema,
  parseLoginMessage,
  verifyRequestSchema,
} from "../src/auth.ts";

const nonce = "4vJ9JU1bJJE96FWSJKvHsm";
const issued = "2026-10-13T12:00:00.000Z";
const domain = "127.0.0.1:3000";

describe("buildLoginMessage", () => {
  it("builds the exact message the wallet signs", () => {
    expect(buildLoginMessage(domain, nonce, issued)).toBe(
      `SolTracer login\nDomain: ${domain}\nNonce: ${nonce}\nIssued: ${issued}`,
    );
  });
});

describe("parseLoginMessage", () => {
  it("round-trips a built message", () => {
    expect(parseLoginMessage(buildLoginMessage(domain, nonce, issued))).toEqual({ domain, nonce, issued });
  });

  it("rejects a wrong header, extra lines or a bad timestamp", () => {
    const msg = (d: string, n: string, i: string) => `SolTracer login\nDomain: ${d}\nNonce: ${n}\nIssued: ${i}`;
    expect(parseLoginMessage(`Other login\nDomain: ${domain}\nNonce: ${nonce}\nIssued: ${issued}`)).toBeNull();
    expect(parseLoginMessage(`${buildLoginMessage(domain, nonce, issued)}\nExtra: 1`)).toBeNull();
    expect(parseLoginMessage(msg(domain, nonce, "yesterday"))).toBeNull();
    expect(parseLoginMessage(msg(domain, "", issued))).toBeNull();
    expect(parseLoginMessage(msg(domain, "not-base58!", issued))).toBeNull();
  });

  it("rejects the old format without a Domain line and invalid domains", () => {
    expect(parseLoginMessage(`SolTracer login\nNonce: ${nonce}\nIssued: ${issued}`)).toBeNull();
    for (const bad of ["", "evil.com/path", "https://evil.com", "a b", "host:99999"]) {
      expect(parseLoginMessage(`SolTracer login\nDomain: ${bad}\nNonce: ${nonce}\nIssued: ${issued}`)).toBeNull();
    }
  });
});

describe("verifyRequestSchema", () => {
  const valid = {
    publicKey: bs58.encode(new Uint8Array(32).fill(3)),
    signature: bs58.encode(new Uint8Array(64).fill(4)),
    message: buildLoginMessage(domain, nonce, issued),
  };

  it("accepts a well-formed request", () => {
    expect(verifyRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an oversized message and unknown keys", () => {
    expect(verifyRequestSchema.safeParse({ ...valid, message: "x".repeat(513) }).success).toBe(false);
    expect(verifyRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("hostSchema", () => {
  it("accepts host and host:port, lowercased", () => {
    expect(hostSchema.parse("127.0.0.1:3000")).toBe("127.0.0.1:3000");
    expect(hostSchema.parse("MyBox.tail1234.ts.net")).toBe("mybox.tail1234.ts.net");
    expect(hostSchema.parse("localhost")).toBe("localhost");
  });

  it("rejects schemes, paths, spaces and bad ports", () => {
    for (const bad of ["", "http://x", "x/y", "a b", "x:0", "x:65536", "x:", "[::1]:3000"]) {
      expect(hostSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("engineVerifyRequestSchema", () => {
  it("adds the domain the web app saw", () => {
    const req = {
      publicKey: bs58.encode(new Uint8Array(32).fill(3)),
      signature: bs58.encode(new Uint8Array(64).fill(4)),
      message: buildLoginMessage(domain, nonce, issued),
    };
    expect(engineVerifyRequestSchema.safeParse({ ...req, domain }).success).toBe(true);
    expect(engineVerifyRequestSchema.safeParse(req).success).toBe(false);
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
