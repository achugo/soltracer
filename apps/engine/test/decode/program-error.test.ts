import { readFileSync } from "node:fs";
import { address, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { parseIdlErrors } from "../../src/decode/idl.ts";
import { describeFailure, locateFailure } from "../../src/decode/program-error.ts";
import { loadOnChain } from "../helpers/sandbox-fixtures.ts";

const JUP = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = address("11111111111111111111111111111111");
const COMPUTE = address("ComputeBudget111111111111111111111111111111");
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const idlFixture = JSON.parse(readFileSync(new URL("../fixtures/idl/jupiter-v6.idl.json", import.meta.url), "utf8")) as {
  rpc: { response: { result: { value: { data: [string, string] } } } }[];
};
const jupiterErrors = {
  program: JUP,
  errors: parseIdlErrors(
    new Uint8Array(Buffer.from(idlFixture.rpc[0]?.response.result.value.data[0] ?? "", "base64")),
  ),
};

// Top-level programs of the recorded slippage failure, in instruction order.
const slippagePrograms: Address[] = [SYSTEM, COMPUTE, ATA, JUP, TOKEN, COMPUTE, COMPUTE];

describe("locateFailure", () => {
  it("finds the failing instruction and the program that raised the error (Jupiter 6001)", () => {
    const fx = loadOnChain("jupiter-slippage-6001");
    expect(locateFailure(fx.meta.err, fx.meta.logMessages, slippagePrograms)).toEqual({
      instructionIndex: 3,
      programId: JUP,
      failingProgramId: JUP,
      customCode: 6001,
    });
  });

  it("attributes an error raised inside a CPI to the callee, from the logs", () => {
    const logs = [
      `Program ${JUP} invoke [1]`,
      `Program ${TOKEN} invoke [2]`,
      `Program ${TOKEN} failed: custom program error: 0x1`,
      `Program ${JUP} failed: custom program error: 0x1`,
    ];
    const site = locateFailure({ InstructionError: [0, { Custom: 1n }] }, logs, [JUP]);
    expect(site).toEqual({ instructionIndex: 0, programId: JUP, failingProgramId: TOKEN, customCode: 1 });
  });

  it("handles transaction-level errors with no instruction", () => {
    expect(locateFailure("BlockhashNotFound", [], [JUP])).toEqual({
      instructionIndex: null,
      programId: null,
      failingProgramId: null,
      customCode: null,
    });
  });
});

describe("describeFailure", () => {
  const site = { instructionIndex: 3, programId: JUP, failingProgramId: JUP, customCode: 6001 };
  const err = { InstructionError: [3, { Custom: 6001 }] };

  it("names a custom error from the program's IDL", () => {
    expect(describeFailure(err, site, jupiterErrors)).toEqual({
      ...site,
      code: 6001,
      name: "SlippageToleranceExceeded",
      message: "Slippage tolerance exceeded",
      source: "idl",
      raw: err,
    });
  });

  it("ignores an IDL that belongs to a different program than the one that failed", () => {
    // Jupiter's IDL must not name a Token error raised through CPI (Token code 1 = InsufficientFunds).
    const cpi = { instructionIndex: 3, programId: JUP, failingProgramId: TOKEN, customCode: 1 };
    expect(describeFailure({ InstructionError: [3, { Custom: 1 }] }, cpi, jupiterErrors)).toMatchObject({
      name: "InsufficientFunds",
      source: "builtin",
    });
    const unknown = { ...cpi, failingProgramId: address("SysvarRent111111111111111111111111111111111"), customCode: 6001 };
    expect(describeFailure({ InstructionError: [3, { Custom: 6001 }] }, unknown, jupiterErrors).source).toBe("raw");
  });

  it("returns a raw error that serializes even when kit gave bigints", () => {
    const out = describeFailure({ InstructionError: [3n, { Custom: 6001n }] }, site, jupiterErrors);
    expect(JSON.parse(JSON.stringify(out.raw))).toEqual({ InstructionError: [3, { Custom: 6001 }] });
  });

  it("falls back to the raw code in decimal and hex when there is no IDL", () => {
    const out = describeFailure(err, site, null);
    expect(out).toMatchObject({ code: 6001, name: null, source: "raw" });
    expect(out.message).toContain("6001");
    expect(out.message).toContain("0x1771");
  });

  it.each([
    [SYSTEM, 1, "ResultWithNegativeLamports"],
    [TOKEN, 1, "InsufficientFunds"],
    [address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), 18, "MintDecimalsMismatch"],
  ])("uses the built-in table for %s code %i", (program, code, name) => {
    const s = { instructionIndex: 0, programId: JUP, failingProgramId: program, customCode: code };
    expect(describeFailure({ InstructionError: [0, { Custom: code }] }, s, null)).toMatchObject({ name, source: "builtin" });
  });

  it("uses Anchor framework errors for an Anchor program below 6000", () => {
    const s = { ...site, customCode: 3012 };
    expect(describeFailure({ InstructionError: [3, { Custom: 3012 }] }, s, jupiterErrors)).toMatchObject({
      code: 3012,
      name: "AccountNotInitialized",
      source: "builtin",
    });
  });

  it("does not apply Anchor names to a program with no IDL", () => {
    const s = { ...site, customCode: 3012 };
    expect(describeFailure({ InstructionError: [3, { Custom: 3012 }] }, s, null)).toMatchObject({ source: "raw" });
  });

  it("describes non-custom instruction errors and transaction-level errors", () => {
    const ix = describeFailure({ InstructionError: [2, "InvalidAccountData"] }, { ...site, instructionIndex: 2, customCode: null }, null);
    expect(ix).toMatchObject({ code: null, name: "InvalidAccountData", message: "Invalid account data", source: "builtin" });

    const none = { instructionIndex: null, programId: null, failingProgramId: null, customCode: null };
    expect(describeFailure("BlockhashNotFound", none, null)).toMatchObject({ name: "BlockhashNotFound", message: "Blockhash not found" });
    expect(describeFailure({ InsufficientFundsForRent: { account_index: 2 } }, none, null)).toMatchObject({
      name: "InsufficientFundsForRent",
      message: "Insufficient funds for rent (account index 2)",
    });
  });
});
