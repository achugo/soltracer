import type { AccountRef } from "@soltracer/shared/simulation";
import type { Address } from "@solana/kit";
import type { DecodedTransaction } from "./decode.ts";

/** Program of each top-level instruction, in order. Legacy/v0 and v1 lay instructions out differently. */
export function instructionPrograms(tx: DecodedTransaction, accounts: readonly AccountRef[]): Address[] {
  const indexes =
    tx.compiled.version === 1
      ? tx.compiled.instructionHeaders.map((h) => h.programAccountIndex)
      : tx.compiled.instructions.map((ix) => ix.programAddressIndex);
  return indexes.map((i) => {
    const account = accounts[i];
    if (!account) throw new Error(`Instruction program index ${i} is out of range`);
    return account.address as Address;
  });
}
