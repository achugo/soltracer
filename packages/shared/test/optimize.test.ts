import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  optimizeRequestSchema,
  optimizeResultSchema,
  txStatusRequestSchema,
  txStatusResultSchema,
  type OptimizeResult,
} from "../src/optimize.ts";
import type { SimulationResult } from "../src/simulation.ts";

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

const sim: SimulationResult = {
  ok: true,
  encoding: "base64",
  version: 0,
  signed: false,
  accounts: [{ address: key(1), writable: true, signer: true, source: { kind: "static" } }],
  computeBudget: {
    limit: 200_000,
    limitSource: "default",
    defaultLimit: 200_000,
    priceMicroLamports: "0",
    priorityFeeLamports: "0",
    loadedAccountsDataSizeLimit: null,
  },
  unitsConsumed: 150,
  status: { success: true },
  fee: { baseLamports: "5000", priorityLamports: "0", totalLamports: "5000" },
  balances: { sol: [], tokens: [] },
  logs: [],
  slot: 1,
  credits: 3,
};

const preset = (price: string, priority: string) => ({
  priceMicroLamports: price,
  priorityFeeLamports: priority,
  totalFeeLamports: String(5000 + Number(priority)),
  tx: "AQID",
});

const result: OptimizeResult = {
  ok: true,
  before: sim,
  after: sim,
  computeUnitLimit: 173,
  presets: { p50: preset("1000", "1"), p75: preset("5000", "1"), p90: preset("20000", "4") },
  chosen: "p75",
  blockhash: key(7),
  lastValidBlockHeight: "300000150",
  contention: { accountsP75: "50000", globalP75: "5000" },
  warnings: [{ code: "CONTENTION", message: "hot" }],
  credits: 11,
};

describe("optimizeRequestSchema", () => {
  it("defaults the preset to p75 and trims the transaction", () => {
    expect(optimizeRequestSchema.parse({ tx: " AQID " })).toEqual({ tx: "AQID", preset: "p75" });
  });

  it("rejects unknown presets and extra fields", () => {
    expect(optimizeRequestSchema.safeParse({ tx: "AQID", preset: "p99" }).success).toBe(false);
    expect(optimizeRequestSchema.safeParse({ tx: "AQID", sign: true }).success).toBe(false);
  });
});

describe("optimizeResultSchema", () => {
  it("accepts a full result", () => {
    expect(optimizeResultSchema.parse(result)).toEqual(result);
  });

  it("accepts no contention data and rejects non-u64 preset fees", () => {
    expect(optimizeResultSchema.safeParse({ ...result, contention: null }).success).toBe(true);
    for (const bad of ["-1", "1.5", ""]) {
      const presets = { ...result.presets, p50: { ...result.presets.p50, priorityFeeLamports: bad } };
      expect(optimizeResultSchema.safeParse({ ...result, presets }).success).toBe(false);
    }
  });

  it("rejects a limit above 1.4M, an unknown warning and a missing preset", () => {
    expect(optimizeResultSchema.safeParse({ ...result, computeUnitLimit: 1_400_001 }).success).toBe(false);
    expect(optimizeResultSchema.safeParse({ ...result, warnings: [{ code: "SEND_IT", message: "x" }] }).success).toBe(false);
    const two = { p50: result.presets.p50, p75: result.presets.p75 };
    expect(optimizeResultSchema.safeParse({ ...result, presets: two }).success).toBe(false);
  });

  it("accepts any of the three presets as chosen and validates the blockhash", () => {
    expect(optimizeResultSchema.safeParse({ ...result, chosen: "p90" }).success).toBe(true);
    expect(optimizeResultSchema.safeParse({ ...result, blockhash: "not-a-hash" }).success).toBe(false);
  });
});

describe("tx status schemas", () => {
  it("accept a signature and a found or missing status", () => {
    const signature = bs58.encode(new Uint8Array(64).fill(9));
    expect(txStatusRequestSchema.parse({ signature })).toEqual({ signature });
    expect(txStatusRequestSchema.safeParse({ signature: key(1) }).success).toBe(false);
    expect(txStatusRequestSchema.safeParse({ signature, commitment: "processed" }).success).toBe(false);
    expect(txStatusResultSchema.safeParse({ ok: true, status: { confirmationStatus: "confirmed", slot: 5 } }).success).toBe(false);
    expect(txStatusResultSchema.parse({ ok: true, status: null })).toEqual({ ok: true, status: null });
    const found = { ok: true, status: { confirmationStatus: "confirmed", err: null, slot: 5 } };
    expect(txStatusResultSchema.parse(found)).toEqual(found);
    expect(txStatusResultSchema.safeParse({ ok: true, status: { confirmationStatus: "landed", err: null, slot: 5 } }).success).toBe(false);
  });
});
