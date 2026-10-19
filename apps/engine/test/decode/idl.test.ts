import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { anchorIdlAddress } from "../../src/decode/idl-address.ts";
import { IdlParseError, parseIdlErrors } from "../../src/decode/idl.ts";
import { jupiterIdlAccountData, loadJupiterIdlFixture, present } from "../helpers/third-party.ts";

// Jupiter's IDL is third-party material, kept in the local fixture cache (null when it isn't there).
const fixture = loadJupiterIdlFixture();
const maybeData = jupiterIdlAccountData();
const data = () => present(maybeData);

describe("anchorIdlAddress", () => {
  it.skipIf(!fixture)("derives the recorded Jupiter v6 IDL account address", async () => {
    const { program, idlAddress } = present(fixture);
    expect(await anchorIdlAddress(address(program))).toBe(idlAddress);
  });
});

describe("parseIdlErrors", () => {
  it.skipIf(!maybeData)("reads every error code from Jupiter's on-chain IDL", () => {
    const errors = parseIdlErrors(data());
    expect(errors.size).toBe(28);
    expect(errors.get(6001)).toEqual({ name: "SlippageToleranceExceeded", message: "Slippage tolerance exceeded" });
  });

  it.skipIf(!maybeData)("rejects truncated, corrupt or oversized data", () => {
    expect(() => parseIdlErrors(data().subarray(0, 30))).toThrow(IdlParseError);
    const corrupt = Uint8Array.from(data());
    corrupt.fill(7, 44, 60);
    expect(() => parseIdlErrors(corrupt)).toThrow(IdlParseError);
    const lying = Uint8Array.from(data());
    new DataView(lying.buffer).setUint32(40, 10_000_000, true);
    expect(() => parseIdlErrors(lying)).toThrow(IdlParseError);
  });
});
