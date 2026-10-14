import {
  DEFAULT_CU_PER_INSTRUCTION,
  MAX_COMPUTE_UNIT_LIMIT,
  type AccountRef,
  type ComputeBudget,
} from "@soltracer/shared/simulation";
import {
  decompileTransactionMessage,
  getTransactionMessageComputeUnitLimit,
  getTransactionMessageComputeUnitPrice,
  getTransactionMessageLoadedAccountsDataSizeLimit,
  getTransactionMessagePriorityFeeLamports,
  type Address,
} from "@solana/kit";
import type { DecodedTransaction } from "./decode.ts";

/** ceil(limit x price / 1e6): the runtime's priority fee in lamports. */
export function priorityFeeLamports(limit: number, priceMicroLamports: bigint): bigint {
  return (BigInt(limit) * priceMicroLamports + 999_999n) / 1_000_000n;
}

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Lookup-table contents implied by the resolved accounts (enough for decompiling). */
export function tablesFrom(accounts: readonly AccountRef[]): Record<Address, Address[]> {
  const tables: Record<Address, Address[]> = {};
  for (const a of accounts) {
    if (a.source.kind !== "lookup") continue;
    const entries = (tables[a.source.table as Address] ??= []);
    entries[a.source.index] = a.address as Address;
  }
  return tables;
}

/**
 * Compute budget as the runtime will apply it. Legacy/v0 read ComputeBudget instructions;
 * v1 reads the message config, whose priority fee is a lamport total rather than a per-CU price.
 */
export function readComputeBudget(tx: DecodedTransaction, accounts: readonly AccountRef[]): ComputeBudget {
  const message = decompileTransactionMessage(tx.compiled, { addressesByLookupTableAddress: tablesFrom(accounts) });
  const workInstructions = message.instructions.filter((ix) => ix.programAddress !== COMPUTE_BUDGET_PROGRAM).length;
  const defaultLimit = Math.min(MAX_COMPUTE_UNIT_LIMIT, DEFAULT_CU_PER_INSTRUCTION * workInstructions);
  const explicit = getTransactionMessageComputeUnitLimit(message);
  const limit = explicit === undefined ? defaultLimit : Math.min(MAX_COMPUTE_UNIT_LIMIT, explicit);
  const loaded = getTransactionMessageLoadedAccountsDataSizeLimit(message);

  if (message.version === 1) {
    return {
      limit,
      limitSource: explicit === undefined ? "default" : "explicit",
      defaultLimit,
      priceMicroLamports: null,
      priorityFeeLamports: (getTransactionMessagePriorityFeeLamports(message) ?? 0n).toString(),
      loadedAccountsDataSizeLimit: loaded ?? null,
    };
  }

  const price = getTransactionMessageComputeUnitPrice(message) ?? 0n;
  const priority = priorityFeeLamports(limit, price);
  return {
    limit,
    limitSource: explicit === undefined ? "default" : "explicit",
    defaultLimit,
    priceMicroLamports: price.toString(),
    priorityFeeLamports: priority.toString(),
    loadedAccountsDataSizeLimit: loaded ?? null,
  };
}
