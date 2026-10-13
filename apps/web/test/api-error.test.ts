import { makeError } from "@soltracer/shared/errors";
import { describe, expect, it } from "vitest";
import { describeApiError } from "../lib/api-error.ts";

describe("describeApiError", () => {
  it("lists each encoding tried for TX_DECODE_FAILED", () => {
    const tried = [
      { encoding: "base64", reason: "not valid base64 (characters or length)" },
      { encoding: "base58", reason: "not a valid transaction: 3 unexpected trailing bytes" },
    ];
    const view = describeApiError(makeError("TX_DECODE_FAILED", "Could not read this.", { tried }));
    expect(view.title).toBe("Could not decode the transaction");
    expect(view.tried).toEqual(tried);
    expect(view.retryable).toBe(false);
  });

  it("ignores malformed decode details instead of trusting them", () => {
    expect(describeApiError(makeError("TX_DECODE_FAILED", "x", { tried: "nope" })).tried).toEqual([]);
    expect(describeApiError(makeError("TX_DECODE_FAILED", "x", null)).tried).toEqual([]);
  });

  it("explains TX_TOO_LARGE with size, limit and version", () => {
    const view = describeApiError(makeError("TX_TOO_LARGE", "too big", { size: 1300, limit: 1232, version: 0 }));
    expect(view.hint).toBe("It is 1,300 bytes; the limit for v0 is 1,232 bytes.");
    expect(describeApiError(makeError("TX_TOO_LARGE", "too big", { size: 5000, limit: 4096 })).hint).toBe(
      "It is 5,000 bytes; the limit is 4,096 bytes.",
    );
  });

  it("suggests retrying when rate limited", () => {
    const view = describeApiError(makeError("RPC_RATE_LIMITED", "429"));
    expect(view.retryable).toBe(true);
    expect(view.hint).toMatch(/retry/i);
  });

  it("offers sign-in for UNAUTHORIZED and not retry", () => {
    const view = describeApiError(makeError("UNAUTHORIZED", "Sign in first."));
    expect(view).toMatchObject({ signIn: true, retryable: false });
  });

  it("keeps the server message for every code", () => {
    for (const code of ["VALIDATION_ERROR", "RPC_ERROR", "NOT_ALLOWLISTED", "ENGINE_UNAVAILABLE", "INTERNAL"] as const) {
      expect(describeApiError(makeError(code, `msg ${code}`)).message).toBe(`msg ${code}`);
    }
  });
});
