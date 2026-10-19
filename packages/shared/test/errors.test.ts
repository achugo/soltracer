import { describe, expect, it } from "vitest";
import { errorResponseSchema, makeError } from "../src/errors.ts";

describe("makeError", () => {
  it("builds a typed error that the schema accepts", () => {
    const err = makeError("NOT_ALLOWLISTED", "This wallet is not on the allowlist.");
    expect(err).toEqual({
      ok: false,
      code: "NOT_ALLOWLISTED",
      message: "This wallet is not on the allowlist.",
      details: null,
    });
    expect(errorResponseSchema.safeParse(err).success).toBe(true);
  });

  it("rejects unknown codes", () => {
    expect(
      errorResponseSchema.safeParse({ ok: false, code: "NOPE", message: "x", details: null }).success,
    ).toBe(false);
  });
});
