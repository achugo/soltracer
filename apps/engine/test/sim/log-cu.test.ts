import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { perInstructionUnits } from "../../src/sim/log-cu.ts";
import { loadOnChain } from "../helpers/sandbox-fixtures.ts";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const COMPUTE = "ComputeBudget111111111111111111111111111111" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

describe("perInstructionUnits", () => {
  it("reports each top-level instruction's own CU and ignores CPI lines (Jupiter, on-chain logs)", () => {
    const fx = loadOnChain("jupiter-slippage-6001");
    const units = perInstructionUnits(fx.meta.logMessages, [SYSTEM, COMPUTE, ATA, JUP, TOKEN, COMPUTE, COMPUTE]);
    expect(units.map((u) => u.programId)).toEqual([SYSTEM, COMPUTE, ATA, JUP, TOKEN, COMPUTE, COMPUTE]);
    expect(units[3]).toEqual({ index: 3, programId: JUP, unitsConsumed: 48_305 });
    expect(units[0]?.unitsConsumed).toBeNull(); // System logs no "consumed" line
    expect(units[4]?.unitsConsumed).toBeNull(); // never ran: the transaction failed at instruction 3
  });

  it("sums to at most the transaction's total CU", () => {
    for (const name of ["jupiter-swap-alt", "token-2022-transfer", "v1-transaction", "sol-transfer"] as const) {
      const fx = loadOnChain(name);
      const programs = fx.meta.logMessages.flatMap((l) => /^Program (\w+) invoke \[1\]$/.exec(l)?.[1] ?? []) as Address[];
      const units = perInstructionUnits(fx.meta.logMessages, programs);
      const total = units.reduce((n, u) => n + (u.unitsConsumed ?? 0), 0);
      expect(total, name).toBeLessThanOrEqual(fx.meta.computeUnitsConsumed);
      expect(units.length, name).toBe(programs.length);
    }
  });

  it("ignores a consumed line that names a different program than the instruction", () => {
    const logs = [`Program ${JUP} invoke [1]`, `Program ${TOKEN} consumed 300 of 100000 compute units`, `Program ${JUP} success`];
    expect(perInstructionUnits(logs, [JUP])).toEqual([{ index: 0, programId: JUP, unitsConsumed: null }]);
  });

  it("handles nested invokes and an empty log", () => {
    const logs = [
      `Program ${JUP} invoke [1]`,
      `Program ${TOKEN} invoke [2]`,
      `Program ${TOKEN} consumed 300 of 100000 compute units`,
      `Program ${TOKEN} success`,
      `Program ${JUP} consumed 5000 of 100000 compute units`,
      `Program ${JUP} success`,
    ];
    expect(perInstructionUnits(logs, [JUP])).toEqual([{ index: 0, programId: JUP, unitsConsumed: 5000 }]);
    expect(perInstructionUnits([], [JUP])).toEqual([{ index: 0, programId: JUP, unitsConsumed: null }]);
  });
});
