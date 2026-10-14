import type { AccountRef } from "@soltracer/shared/simulation";
import type { Address } from "@solana/kit";
import type { DecodedTransaction } from "./decode.ts";

export interface TopLevelInstruction {
  programId: Address;
  accounts: Address[];
  data: Uint8Array;
}

/** Each top-level instruction with its program, accounts and data. Legacy/v0 and v1 lay them out differently. */
export function topLevelInstructions(tx: DecodedTransaction, accounts: readonly AccountRef[]): TopLevelInstruction[] {
  const at = (i: number): Address => {
    const account = accounts[i];
    if (!account) throw new Error(`Instruction account index ${i} is out of range`);
    return account.address as Address;
  };
  if (tx.compiled.version === 1) {
    const { instructionHeaders, instructionPayloads } = tx.compiled;
    return instructionHeaders.map((h, i) => {
      const payload = instructionPayloads[i];
      return {
        programId: at(h.programAccountIndex),
        accounts: (payload?.instructionAccountIndices ?? []).map(at),
        data: Uint8Array.from(payload?.instructionData ?? []),
      };
    });
  }
  return tx.compiled.instructions.map((ix) => ({
    programId: at(ix.programAddressIndex),
    accounts: (ix.accountIndices ?? []).map(at),
    data: Uint8Array.from(ix.data ?? []),
  }));
}
