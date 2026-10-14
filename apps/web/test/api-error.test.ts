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

  it("explains LOCAL_LOAD_FAILED and how to fall back", () => {
    const view = describeApiError(makeError("LOCAL_LOAD_FAILED", "accounts unavailable"));
    expect(view.message).toBe("accounts unavailable");
    expect(view.hint).toBe(
      "Couldn't load mainnet state locally, so overrides can't be applied. Remove the overrides to fall back to RPC.",
    );
    expect(view.retryable).toBe(true);
  });

  it("keeps the server message for every code", () => {
    for (const code of ["VALIDATION_ERROR", "RPC_ERROR", "NOT_ALLOWLISTED", "ENGINE_UNAVAILABLE", "LOCAL_LOAD_FAILED", "INTERNAL"] as const) {
      expect(describeApiError(makeError(code, `msg ${code}`)).message).toBe(`msg ${code}`);
    }
  });
});

describe("describeApiError for the optimizer", () => {
  const txError = {
    instructionIndex: 2,
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    failingProgramId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    code: 6001,
    name: "SlippageToleranceExceeded",
    message: "Slippage tolerance exceeded",
    source: "idl" as const,
    raw: { InstructionError: [2, { Custom: 6001 }] },
  };

  it("explains OPTIMIZE_NOT_FIXABLE with the decoded error", () => {
    const view = describeApiError(makeError("OPTIMIZE_NOT_FIXABLE", "Can't fix.", { error: txError }), "optimize");
    expect(view.title).toBe("Fees and limits can't fix this");
    expect(view.message).toBe("Can't fix.");
    expect(view.txError).toEqual(txError);
    expect(view.retryable).toBe(false);
  });

  it("ignores malformed refusal details", () => {
    expect(describeApiError(makeError("OPTIMIZE_NOT_FIXABLE", "x", { error: { name: 1 } })).txError).toBeNull();
    expect(describeApiError(makeError("OPTIMIZE_NOT_FIXABLE", "x", null)).txError).toBeNull();
  });

  it("titles unmapped errors by action", () => {
    expect(describeApiError(makeError("NOT_FOUND", "x")).title).toBe("Simulation failed");
    expect(describeApiError(makeError("NOT_FOUND", "x"), "optimize").title).toBe("Optimization failed");
    expect(describeApiError(makeError("NOT_FOUND", "x"), "status").title).toBe("Status check failed");
  });

  it("keeps rate limits and RPC errors retryable by hand", () => {
    expect(describeApiError(makeError("RPC_RATE_LIMITED", "429"), "optimize").retryable).toBe(true);
    expect(describeApiError(makeError("RPC_ERROR", "502"), "optimize").retryable).toBe(true);
  });
});
