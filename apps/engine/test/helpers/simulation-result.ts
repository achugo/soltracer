import type { SimulationResult } from "@soltracer/shared/simulation";

// Well-known program ids stand in for wallets: no real user addresses in fixtures.
export const PAYER = "Vote111111111111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";

/** A complete, contract-valid result to store and read back. */
export function simulationResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    ok: true,
    encoding: "base64",
    version: 0,
    signed: false,
    accounts: [
      { address: PAYER, writable: true, signer: true, source: { kind: "static" } },
      { address: SYSTEM, writable: false, signer: false, source: { kind: "static" } },
    ],
    computeBudget: { limit: 200_000, limitSource: "default", defaultLimit: 200_000, priceMicroLamports: "0", priorityFeeLamports: "0", loadedAccountsDataSizeLimit: null },
    unitsConsumed: 150,
    status: { success: true },
    fee: { baseLamports: "5000", priorityLamports: "0", totalLamports: "5000" },
    balances: { sol: [{ address: PAYER, pre: "18446744073709551615", post: "18446744073709546615", delta: "-5000" }], tokens: [] },
    logs: [`Program ${SYSTEM} invoke [1]`, `Program ${SYSTEM} success`],
    slot: 300_000_000,
    credits: 3,
    engine: "local",
    fallbackReason: null,
    perInstruction: [],
    overrides: [],
    trace: { nodes: [], failingNodeId: null, complete: true },
    accountDiffs: [],
    replay: null,
    runId: null,
    ...overrides,
  };
}
