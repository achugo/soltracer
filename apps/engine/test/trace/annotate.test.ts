import { MAX_INSTRUCTION_DATA_BYTES, traceSchema } from "@soltracer/shared/trace";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { annotateTrace, type TraceDetails } from "../../src/trace/annotate.ts";
import { buildCpiTree } from "../../src/trace/cpi-tree.ts";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const PAYER = "Vote111111111111111111111111111111111111111" as Address;

const logs = [`Program ${JUP} invoke [1]`, `Program ${TOKEN} invoke [2]`, `Program ${TOKEN} success`, `Program ${JUP} success`];
const tree = buildCpiTree({ logs, programs: [JUP], failed: false, failedInstruction: null });
const base: TraceDetails = {
  status: { success: true },
  instructions: [{ programId: JUP, accounts: [PAYER, TOKEN], data: Uint8Array.from([1, 2]) }],
  accountKeys: [PAYER, JUP, TOKEN],
  inner: [[{ programIdIndex: 2, accounts: [0], data: Uint8Array.from([3]), stackHeight: 2 }]],
  idls: new Map(),
};

describe("annotateTrace", () => {
  it("attaches top-level and matched inner instruction data, raw without an IDL", () => {
    const trace = annotateTrace(tree, base);
    expect(traceSchema.safeParse(trace).error).toBeUndefined();
    expect(trace.nodes.map((n) => n.instruction)).toEqual([
      { data: "0102", accounts: [PAYER, TOKEN], decoded: null },
      { data: "03", accounts: [PAYER], decoded: null },
    ]);
    expect(tree.nodes.every((n) => n.instruction === null)).toBe(true); // the input is not changed
  });

  it.each([
    ["a different count", [[]]],
    ["a different stack height", [[{ programIdIndex: 2, accounts: [0], data: Uint8Array.from([3]), stackHeight: 3 }]]],
    ["a different program", [[{ programIdIndex: 0, accounts: [0], data: Uint8Array.from([3]), stackHeight: 2 }]]],
    ["an account index out of range", [[{ programIdIndex: 2, accounts: [9], data: Uint8Array.from([3]), stackHeight: 2 }]]],
  ])("leaves CPI data off when the inner instructions don't match (%s)", (_, inner) => {
    const trace = annotateTrace(tree, { ...base, inner });
    expect(trace.nodes[1]?.instruction).toBeNull();
    expect(trace.nodes[0]?.instruction).not.toBeNull();
  });

  it("omits data too large to carry, and attaches the error to the failing node only", () => {
    const failedTree = buildCpiTree({
      logs: [`Program ${JUP} invoke [1]`, `Program ${JUP} failed: custom program error: 0x1`],
      programs: [JUP],
      failed: true,
      failedInstruction: 0,
    });
    const error = { instructionIndex: 0, programId: JUP, failingProgramId: JUP, code: 1, name: null, message: "custom program error: 0x1", source: "raw" as const, raw: null };
    const trace = annotateTrace(failedTree, {
      ...base,
      status: { success: false, error },
      instructions: [{ programId: JUP, accounts: [], data: new Uint8Array(MAX_INSTRUCTION_DATA_BYTES + 1) }],
      inner: null,
    });
    expect(trace.nodes[0]).toMatchObject({ error, instruction: null });
    expect(traceSchema.safeParse(trace).error).toBeUndefined();
  });
});
