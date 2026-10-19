import { getBase64Encoder, type Address } from "@solana/kit";
import { RpcError, type SolanaRpc } from "./client.ts";

/** getMultipleAccounts accepts at most 100 keys per call. */
export const MAX_ACCOUNTS_PER_CALL = 100;

export interface AccountSnapshot {
  address: Address;
  lamports: bigint;
  owner: Address;
  executable: boolean;
  data: Uint8Array;
}

const base64 = getBase64Encoder();

/** Reads accounts in batches of 100, in input order; missing accounts are null. */
export async function getMultipleAccountsBatched(
  rpc: SolanaRpc,
  addresses: readonly Address[],
): Promise<{ slot: bigint | null; accounts: (AccountSnapshot | null)[] }> {
  const accounts: (AccountSnapshot | null)[] = [];
  let slot: bigint | null = null;
  for (let start = 0; start < addresses.length; start += MAX_ACCOUNTS_PER_CALL) {
    const batch = addresses.slice(start, start + MAX_ACCOUNTS_PER_CALL);
    const { context, value } = await rpc
      .getMultipleAccounts(batch, { encoding: "base64", commitment: "confirmed" })
      .send();
    if (value.length !== batch.length) {
      throw new RpcError(
        "RPC_ERROR",
        "getMultipleAccounts",
        `getMultipleAccounts returned ${value.length} accounts for ${batch.length} keys`,
      );
    }
    slot = slot === null || context.slot > slot ? context.slot : slot;
    value.forEach((account, i) => {
      const addr = batch[i];
      if (!account || addr === undefined) {
        accounts.push(null);
        return;
      }
      accounts.push({
        address: addr,
        lamports: account.lamports,
        owner: account.owner,
        executable: account.executable,
        data: new Uint8Array(base64.encode(account.data[0])),
      });
    });
  }
  return { slot, accounts };
}
