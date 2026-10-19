import type { AccountDiff, Trace } from "@soltracer/shared/trace";
import { describe, expect, it } from "vitest";
import { normalizeIdl } from "../../src/decode/idl-full.ts";
import { IdlParseError } from "../../src/decode/idl.ts";
import { diffsWithoutInvalidDecoding, withoutInvalidDecoding } from "../../src/trace/schema-safe.ts";

const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const trace = (decodedName: string): Trace => ({
  nodes: [
    {
      id: 0, parent: null, depth: 1, instructionIndex: 0, programId: PROGRAM, status: "success",
      consumed: 1, budget: 2, selfConsumed: 1, error: null, logs: [], logsDropped: 0, returnData: null,
      instruction: { data: "01", accounts: [], decoded: { name: decodedName, args: {}, accountNames: [] } },
    },
  ],
  failingNodeId: null,
  complete: true,
});

const diff = (type: string): AccountDiff => {
  const side = { lamports: "1", owner: PROGRAM, dataLength: 1, decoded: { layout: "idl" as const, type, fields: {} } };
  return { address: PROGRAM, before: side, after: { ...side, lamports: "2" }, changedRanges: [], rangesTruncated: false };
};

describe("decoding a hostile IDL can't fail a run", () => {
  it("IDLs with empty account or type names are rejected outright", () => {
    expect(() => normalizeIdl({ instructions: [], accounts: [{ name: "", discriminator: [1] }] })).toThrow(IdlParseError);
    expect(() => normalizeIdl({ instructions: [], types: [{ name: "", type: { kind: "struct" } }] })).toThrow(IdlParseError);
  });

  it("a trace whose decoding breaks the contract renders raw; a valid one is untouched", () => {
    const good = trace("route");
    expect(withoutInvalidDecoding(good)).toBe(good);
    expect(withoutInvalidDecoding(trace("")).nodes[0]?.instruction).toEqual({ data: "01", accounts: [], decoded: null });
  });

  it("an account diff whose decoding breaks the contract renders raw, per account", () => {
    const [good, bad] = diffsWithoutInvalidDecoding([diff("Pool"), diff("")]);
    expect(good?.after?.decoded?.type).toBe("Pool");
    expect([bad?.before?.decoded, bad?.after?.decoded]).toEqual([null, null]);
  });
});
