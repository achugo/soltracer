import { makeError, type ErrorResponse } from "@soltracer/shared/errors";
import { MAX_COMPUTE_UNIT_LIMIT, maxTxBytes, type AccountRef } from "@soltracer/shared/simulation";
import {
  blockhash as toBlockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  isTransactionMessageWithDurableNonceLifetime,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessagePriorityFeeLamports,
  type Address,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM, priorityFeeLamports, tablesFrom } from "../tx/compute-budget.ts";
import type { DecodedTransaction } from "../tx/decode.ts";

export interface RewriteInput {
  tx: DecodedTransaction;
  accounts: readonly AccountRef[];
  limit: number;
  /** Micro-lamports per CU. v1 transactions get the equivalent total fee instead. */
  priceMicroLamports: bigint;
  lifetime: { blockhash: string; lastValidBlockHeight: bigint };
}

export type RewriteOutcome =
  | { ok: true; wireBase64: string; size: number; durableNonce: boolean }
  | { ok: false; error: ErrorResponse };

/**
 * Sets the CU limit and priority fee, refreshes the blockhash (unless the transaction uses a
 * durable nonce) and returns it unsigned. Every other instruction is left as it was.
 */
export function rewriteTransaction({ tx, accounts, limit, priceMicroLamports, lifetime }: RewriteInput): RewriteOutcome {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMPUTE_UNIT_LIMIT || priceMicroLamports < 0n) {
    return { ok: false, error: makeError("VALIDATION_ERROR", "Invalid compute unit limit or price.", { limit }) };
  }
  const tables = tablesFrom(accounts);
  let message = decompileTransactionMessage(tx.compiled, { addressesByLookupTableAddress: tables });
  message = setTransactionMessageComputeUnitLimit(limit, message);
  // A zero fee needs no instruction or config entry; undefined removes any existing one.
  const fee = priceMicroLamports === 0n ? undefined : priceMicroLamports;
  message =
    message.version === 1
      ? setTransactionMessagePriorityFeeLamports(fee === undefined ? undefined : priorityFeeLamports(limit, fee), message)
      : setTransactionMessageComputeUnitPrice(fee, message);

  const durableNonce = isTransactionMessageWithDurableNonceLifetime(message);
  if (!durableNonce) {
    message = setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: toBlockhash(lifetime.blockhash), lastValidBlockHeight: lifetime.lastValidBlockHeight },
      message,
    );
  }
  // Re-use the same lookup tables so the rewritten v0 transaction stays as small as the original.
  const compressed =
    message.version === 0 && Object.keys(tables).length > 0
      ? compressTransactionMessageUsingAddressLookupTables(message, tables)
      : message;

  // compileTransaction leaves every signature empty: the wallet signs the rewritten message.
  const wireBase64 = getBase64EncodedWireTransaction(compileTransaction(compressed));
  const size = Buffer.from(wireBase64, "base64").length;
  const limitBytes = maxTxBytes(tx.version);
  if (size > limitBytes) {
    return {
      ok: false,
      error: makeError(
        "TX_TOO_LARGE",
        `Adding compute budget settings makes this transaction ${size} bytes, over the ${limitBytes}-byte limit.`,
        { size, limit: limitBytes, version: tx.version },
      ),
    };
  }
  return { ok: true, wireBase64, size, durableNonce };
}

export interface NormalizedInstruction {
  programAddress: Address;
  accounts: { address: Address; role: number }[];
  /** Hex of the instruction data. */
  data: string;
}

/**
 * Every instruction except ComputeBudget, as program + accounts (with roles) + data: everything a
 * program can observe. This is what "non-budget instructions stay byte-identical" means: compiled
 * account indexes legitimately move when the ComputeBudget program is added to the static keys.
 */
export function nonBudgetInstructions(tx: DecodedTransaction, accounts: readonly AccountRef[]): NormalizedInstruction[] {
  const message = decompileTransactionMessage(tx.compiled, { addressesByLookupTableAddress: tablesFrom(accounts) });
  return message.instructions
    .filter((ix) => ix.programAddress !== COMPUTE_BUDGET_PROGRAM)
    .map((ix) => ({
      programAddress: ix.programAddress,
      accounts: (ix.accounts ?? []).map((a) => ({ address: a.address, role: a.role })),
      data: Buffer.from(ix.data ?? new Uint8Array()).toString("hex"),
    }));
}

/** ComputeBudget instructions cost this many CU each when they run. */
export const BUDGET_INSTRUCTION_CU = 150;

/**
 * CU the rewrite adds by inserting SetComputeUnitLimit/SetComputeUnitPrice where the original had
 * none (legacy/v0). v1 keeps its budget in the message config, which costs nothing to execute.
 */
export function addedBudgetCost(tx: DecodedTransaction, accounts: readonly AccountRef[]): number {
  if (tx.version === 1) return 0;
  const message = decompileTransactionMessage(tx.compiled, { addressesByLookupTableAddress: tablesFrom(accounts) });
  const present = new Set(
    message.instructions
      .filter((ix) => ix.programAddress === COMPUTE_BUDGET_PROGRAM)
      .map((ix) => ix.data?.[0])
      .filter((d) => d === 2 || d === 3), // 2 = SetComputeUnitLimit, 3 = SetComputeUnitPrice
  );
  return (2 - present.size) * BUDGET_INSTRUCTION_CU;
}

/** The two ComputeBudget instructions the optimizer manages: SetComputeUnitLimit (2) and SetComputeUnitPrice (3). */
function isManagedBudgetInstruction(programAddress: Address, data: Uint8Array | undefined): boolean {
  return programAddress === COMPUTE_BUDGET_PROGRAM && (data?.[0] === 2 || data?.[0] === 3);
}

export interface MessageInvariants {
  feePayer: string;
  /** Sorted addresses that must sign. */
  signers: string[];
  /** Sorted addresses the message requests write access to. */
  writable: string[];
  /** Every instruction except SetComputeUnitLimit/SetComputeUnitPrice, in order. */
  instructions: NormalizedInstruction[];
}

/**
 * What a rewrite must never change. The only account a rewrite may add is the ComputeBudget
 * program itself, read-only and not a signer, so it appears in none of these lists.
 */
export function messageInvariants(tx: DecodedTransaction, accounts: readonly AccountRef[]): MessageInvariants {
  const message = decompileTransactionMessage(tx.compiled, { addressesByLookupTableAddress: tablesFrom(accounts) });
  return {
    feePayer: accounts[0]?.address ?? "",
    signers: accounts.filter((a) => a.signer).map((a) => a.address).sort(),
    writable: [...new Set(accounts.filter((a) => a.writable).map((a) => a.address))].sort(),
    instructions: message.instructions
      .filter((ix) => !isManagedBudgetInstruction(ix.programAddress, ix.data as Uint8Array | undefined))
      .map((ix) => ({
        programAddress: ix.programAddress,
        accounts: (ix.accounts ?? []).map((a) => ({ address: a.address, role: a.role })),
        data: Buffer.from(ix.data ?? new Uint8Array()).toString("hex"),
      })),
  };
}
