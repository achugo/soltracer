import type { SimulationResult } from "@soltracer/shared/simulation";

// Well-known program and sysvar ids stand in for wallets: no real user addresses in fixtures.
export const PAYER = "Vote111111111111111111111111111111111111111";
export const OTHER = "Stake11111111111111111111111111111111111111";
export const THIRD = "SysvarRent111111111111111111111111111111111";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM = "11111111111111111111111111111111";
export const ATA_A = "SysvarC1ock11111111111111111111111111111111";
export const ATA_B = "SysvarS1otHashes111111111111111111111111111";

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
    balances: {
      sol: [{ address: PAYER, pre: "1000000000", post: "899995000", delta: "-100005000" }],
      tokens: [],
    },
    logs: ["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 success"],
    slot: 300_000_000,
    credits: 3,
    engine: "rpc",
    fallbackReason: null,
    perInstruction: [],
    overrides: [],
    runId: null,
    ...overrides,
  };
}
