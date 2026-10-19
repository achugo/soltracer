import { readFileSync } from "node:fs";
import { address, type Address } from "@solana/kit";
import { z } from "zod";

export const SANDBOX_FIXTURES = [
  "sol-transfer",
  "jupiter-swap-alt",
  "jupiter-slippage-6001",
  "token-2022-transfer",
  "v1-transaction",
] as const;
export type SandboxFixtureName = (typeof SANDBOX_FIXTURES)[number];
/** Every recorded getTransaction (some have no simulator recording). */
export const ON_CHAIN_FIXTURES = [...SANDBOX_FIXTURES, "jupiter-swap-fresh", "jupiter-usdc-input"] as const;
export type OnChainFixtureName = (typeof ON_CHAIN_FIXTURES)[number];

const tokenBalance = z.object({
  accountIndex: z.number(),
  mint: z.string(),
  owner: z.string(),
  programId: z.string(),
  uiTokenAmount: z.object({ amount: z.string(), decimals: z.number() }),
});

const resultSchema = z.object({
  transaction: z.tuple([z.string(), z.literal("base64")]),
  version: z.union([z.literal("legacy"), z.literal(0), z.literal(1)]),
  meta: z.object({
    err: z.unknown(),
    fee: z.number(),
    computeUnitsConsumed: z.number(),
    preBalances: z.array(z.number()),
    postBalances: z.array(z.number()),
    preTokenBalances: z.array(tokenBalance),
    postTokenBalances: z.array(tokenBalance),
    logMessages: z.array(z.string()),
    loadedAddresses: z.object({ writable: z.array(z.string()), readonly: z.array(z.string()) }).optional(),
    innerInstructions: z
      .array(
        z.object({
          index: z.number(),
          instructions: z.array(z.object({ programIdIndex: z.number(), accounts: z.array(z.number()), data: z.string(), stackHeight: z.number() })),
        }),
      )
      .optional(),
  }),
});

export type OnChainTx = z.infer<typeof resultSchema> & { signature: string };

/** The on-chain truth recorded by scripts/fixtures.ts (getTransaction, base64). */
export function loadOnChain(name: OnChainFixtureName): OnChainTx {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/sandbox/${name}.tx.json`, import.meta.url), "utf8")) as {
    signature: string;
    rpc: { response: { result: unknown } }[];
  };
  const first = raw.rpc[0];
  if (!first) throw new Error(`${name} has no recorded calls`);
  return { ...resultSchema.parse(first.response.result), signature: raw.signature };
}

const FILLER = address("11111111111111111111111111111111");

/** Rebuilds each lookup table's contents from on-chain loadedAddresses; unused slots get a filler. */
export function tablesFromMeta(
  lookups: readonly { table: Address; writableIndexes: number[]; readonlyIndexes: number[] }[],
  fx: OnChainTx,
): Map<Address, Address[]> {
  const loaded = fx.meta.loadedAddresses ?? { writable: [], readonly: [] };
  let w = 0;
  let r = 0;
  const tables = new Map<Address, Address[]>();
  for (const lookup of lookups) {
    const size = Math.max(...lookup.writableIndexes, ...lookup.readonlyIndexes) + 1;
    const entries: Address[] = Array.from({ length: size }, () => FILLER);
    for (const i of lookup.writableIndexes) entries[i] = address(loaded.writable[w++] ?? "");
    for (const i of lookup.readonlyIndexes) entries[i] = address(loaded.readonly[r++] ?? "");
    tables.set(lookup.table, entries);
  }
  return tables;
}
