import { readFileSync } from "node:fs";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { anchorIdlAddress } from "../../src/decode/idl-address.ts";
import { IdlParseError, parseIdlErrors } from "../../src/decode/idl.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/idl/jupiter-v6.idl.json", import.meta.url), "utf8")) as {
  program: string;
  idlAddress: string;
  rpc: { response: { result: { value: { data: [string, string] } } } }[];
};
const data = new Uint8Array(Buffer.from(fixture.rpc[0]?.response.result.value.data[0] ?? "", "base64"));

describe("anchorIdlAddress", () => {
  it("derives the recorded Jupiter v6 IDL account address", async () => {
    expect(await anchorIdlAddress(address(fixture.program))).toBe(fixture.idlAddress);
  });
});

describe("parseIdlErrors", () => {
  it("reads every error code from Jupiter's on-chain IDL", () => {
    const errors = parseIdlErrors(data);
    expect(errors.size).toBe(28);
    expect(errors.get(6001)).toEqual({ name: "SlippageToleranceExceeded", message: "Slippage tolerance exceeded" });
  });

  it("rejects truncated, corrupt or oversized data", () => {
    expect(() => parseIdlErrors(data.subarray(0, 30))).toThrow(IdlParseError);
    const corrupt = Uint8Array.from(data);
    corrupt.fill(7, 44, 60);
    expect(() => parseIdlErrors(corrupt)).toThrow(IdlParseError);
    const lying = Uint8Array.from(data);
    new DataView(lying.buffer).setUint32(40, 10_000_000, true);
    expect(() => parseIdlErrors(lying)).toThrow(IdlParseError);
  });
});
