import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CU_PER_INSTRUCTION,
  formatUnits,
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_TX_BYTES,
  MAX_V1_TX_BYTES,
  maxTxBytes,
  simulateRequestSchema,
  simulationResultSchema,
  type SimulationResult,
} from "../src/simulation.ts";

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

const success: SimulationResult = {
  ok: true,
  encoding: "base64",
  version: 0,
  signed: false,
  accounts: [
    { address: key(1), writable: true, signer: true, source: { kind: "static" } },
    { address: key(2), writable: true, signer: false, source: { kind: "lookup", table: key(9), index: 3 } },
  ],
  computeBudget: {
    limit: 300_000,
    limitSource: "explicit",
    defaultLimit: 400_000,
    priceMicroLamports: "5000",
    priorityFeeLamports: "1500",
    loadedAccountsDataSizeLimit: null,
  },
  unitsConsumed: 123_456,
  status: { success: true },
  fee: { baseLamports: "5000", priorityLamports: "1500", totalLamports: "6500" },
  balances: {
    sol: [{ address: key(1), pre: "1000000000", post: "999993500", delta: "-6500" }],
    tokens: [
      {
        account: key(3),
        owner: key(1),
        mint: key(4),
        program: "token",
        decimals: 6,
        pre: "0",
        post: "18446744073709551615",
        delta: "18446744073709551615",
      },
    ],
  },
  logs: ["Program 11111111111111111111111111111111 invoke [1]"],
  slot: 300_000_000,
  credits: 5,
};

describe("constants", () => {
  it("match the Solana limits the docs name", () => {
    expect(MAX_TX_BYTES).toBe(1232);
    expect(MAX_COMPUTE_UNIT_LIMIT).toBe(1_400_000);
    expect(DEFAULT_CU_PER_INSTRUCTION).toBe(200_000);
    expect(MAX_V1_TX_BYTES).toBe(4096);
  });

  it("gives v1 transactions the larger size limit", () => {
    expect(maxTxBytes("legacy")).toBe(1232);
    expect(maxTxBytes(0)).toBe(1232);
    expect(maxTxBytes(1)).toBe(4096);
  });
});

describe("simulateRequestSchema", () => {
  it("trims and accepts a transaction string", () => {
    expect(simulateRequestSchema.parse({ tx: "  AQID  " })).toEqual({ tx: "AQID" });
  });

  it("rejects empty, oversized and extra fields", () => {
    expect(simulateRequestSchema.safeParse({ tx: "   " }).success).toBe(false);
    expect(simulateRequestSchema.safeParse({ tx: "A".repeat(6000) }).success).toBe(true);
    expect(simulateRequestSchema.safeParse({ tx: "A".repeat(6001) }).success).toBe(false);
    expect(simulateRequestSchema.safeParse({ tx: "AQID", engine: "local" }).success).toBe(false);
  });
});

describe("simulationResultSchema", () => {
  it("accepts a successful result with u64 amounts beyond 2^53", () => {
    expect(simulationResultSchema.parse(success)).toEqual(success);
  });

  it("accepts a failure with a decoded error", () => {
    const failed = {
      ...success,
      status: {
        success: false,
        error: {
          instructionIndex: 3,
          programId: key(5),
          failingProgramId: key(6),
          code: 6001,
          name: "SlippageToleranceExceeded",
          message: "Slippage tolerance exceeded",
          source: "idl",
          raw: { InstructionError: [3, { Custom: 6001 }] },
        },
      },
    };
    expect(simulationResultSchema.safeParse(failed).success).toBe(true);
  });

  it("accepts a v1 result with a total priority fee and no per-CU price", () => {
    const v1 = {
      ...success,
      version: 1,
      computeBudget: { ...success.computeBudget, priceMicroLamports: null, priorityFeeLamports: "241", loadedAccountsDataSizeLimit: 35_000_000 },
      fee: { baseLamports: "5000", priorityLamports: "241", totalLamports: "5241" },
    };
    expect(simulationResultSchema.safeParse(v1).success).toBe(true);
    expect(simulationResultSchema.safeParse({ ...success, version: 2 }).success).toBe(false);
  });

  it("rejects inconsistent compute budget and fee combinations", () => {
    const v1WithPrice = { ...success, version: 1 };
    const v0WithoutPrice = { ...success, computeBudget: { ...success.computeBudget, priceMicroLamports: null } };
    const feeMismatch = { ...success, fee: { ...success.fee, priorityLamports: "1499" } };
    for (const bad of [v1WithPrice, v0WithoutPrice, feeMismatch]) {
      expect(simulationResultSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects a 21-digit delta", () => {
    const tokens = [{ ...success.balances.tokens[0], delta: "1".repeat(21) }];
    expect(simulationResultSchema.safeParse({ ...success, balances: { ...success.balances, tokens } }).success).toBe(false);
  });

  it("rejects non-integer or negative amounts where they cannot be negative", () => {
    const badFee = { ...success, fee: { ...success.fee, baseLamports: "1.5" } };
    const negPre = { ...success, balances: { ...success.balances, sol: [{ ...success.balances.sol[0], pre: "-1" }] } };
    expect(simulationResultSchema.safeParse(badFee).success).toBe(false);
    expect(simulationResultSchema.safeParse(negPre).success).toBe(false);
  });

  it("rejects a limit above 1.4M and an unknown token program", () => {
    const bigLimit = { ...success, computeBudget: { ...success.computeBudget, limit: 1_400_001 } };
    const badProgram = {
      ...success,
      balances: { ...success.balances, tokens: [{ ...success.balances.tokens[0], program: "token-2023" }] },
    };
    expect(simulationResultSchema.safeParse(bigLimit).success).toBe(false);
    expect(simulationResultSchema.safeParse(badProgram).success).toBe(false);
  });
});

describe("formatUnits", () => {
  it.each([
    ["0", 9, "0"],
    ["1", 9, "0.000000001"],
    ["1500000000", 9, "1.5"],
    ["-6500", 9, "-0.0000065"],
    ["18446744073709551615", 6, "18446744073709.551615"],
    ["42", 0, "42"],
    ["-42", 0, "-42"],
    ["1000000", 6, "1"],
    ["-0", 9, "0"],
    ["-000", 2, "0"],
  ])("formats %s with %i decimals as %s", (raw, decimals, expected) => {
    expect(formatUnits(raw, decimals)).toBe(expected);
  });

  it("rejects malformed input instead of guessing", () => {
    expect(() => formatUnits("1.5", 6)).toThrow();
    expect(() => formatUnits("abc", 6)).toThrow();
    expect(() => formatUnits("1", -1)).toThrow();
    expect(() => formatUnits("1", 1.5)).toThrow();
  });
});
