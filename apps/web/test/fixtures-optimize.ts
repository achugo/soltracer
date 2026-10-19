import type { OptimizeResult } from "@soltracer/shared/optimize";
import { simulationResult } from "./fixtures-simulation.ts";

// A 32-byte id stands in for a blockhash; no real chain data is needed for view logic.
export const BLOCKHASH = "SysvarRecentB1ockHashes11111111111111111111";

export function optimizeResult(overrides: Partial<OptimizeResult> = {}): OptimizeResult {
  return {
    ok: true,
    before: simulationResult({
      unitsConsumed: 180_000,
      computeBudget: {
        limit: 200_000,
        limitSource: "default",
        defaultLimit: 200_000,
        priceMicroLamports: "0",
        priorityFeeLamports: "0",
        loadedAccountsDataSizeLimit: null,
      },
      fee: { baseLamports: "5000", priorityLamports: "0", totalLamports: "5000" },
    }),
    after: simulationResult({
      unitsConsumed: 180_300,
      computeBudget: {
        limit: 207_345,
        limitSource: "explicit",
        defaultLimit: 400_000,
        priceMicroLamports: "20000",
        priorityFeeLamports: "4147",
        loadedAccountsDataSizeLimit: null,
      },
      fee: { baseLamports: "5000", priorityLamports: "4147", totalLamports: "9147" },
    }),
    computeUnitLimit: 207_345,
    presets: {
      p50: { priceMicroLamports: "10000", priorityFeeLamports: "2074", totalFeeLamports: "7074", tx: "AQID" },
      p75: { priceMicroLamports: "20000", priorityFeeLamports: "4147", totalFeeLamports: "9147", tx: "BAUG" },
      p90: { priceMicroLamports: "1500000", priorityFeeLamports: "311018", totalFeeLamports: "316018", tx: "BwgJ" },
    },
    chosen: "p75",
    blockhash: BLOCKHASH,
    lastValidBlockHeight: "280000150",
    contention: null,
    warnings: [],
    credits: 9,
    ...overrides,
  };
}
