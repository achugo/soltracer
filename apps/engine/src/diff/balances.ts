import type { Address } from "@solana/kit";
import { parseTokenAccount, type TokenAccountState } from "../decode/token-account.ts";

export interface AccountState {
  lamports: bigint;
  owner: Address;
  data: Uint8Array;
}

export interface SolChange {
  address: Address;
  pre: bigint;
  post: bigint;
  delta: bigint;
}

export interface TokenChange {
  account: Address;
  owner: Address;
  mint: Address;
  program: TokenAccountState["program"];
  pre: bigint;
  post: bigint;
  delta: bigint;
}

/**
 * SOL and token balance changes between two snapshots of the same accounts (null = absent).
 * Unchanged balances are omitted. `mints` lists every mint involved, for decimals lookup.
 */
export function diffBalances(
  addresses: readonly Address[],
  pre: readonly (AccountState | null)[],
  post: readonly (AccountState | null)[],
): { sol: SolChange[]; tokens: TokenChange[]; mints: Address[] } {
  if (pre.length !== addresses.length || post.length !== addresses.length) {
    throw new Error("Pre and post account lists must line up with the addresses");
  }
  const sol: SolChange[] = [];
  const tokens: TokenChange[] = [];
  const mints = new Set<Address>();

  addresses.forEach((address, i) => {
    const before = pre[i] ?? null;
    const after = post[i] ?? null;
    const preLamports = before?.lamports ?? 0n;
    const postLamports = after?.lamports ?? 0n;
    if (preLamports !== postLamports) {
      sol.push({ address, pre: preLamports, post: postLamports, delta: postLamports - preLamports });
    }

    const preToken = before ? parseTokenAccount(before.owner, before.data) : null;
    const postToken = after ? parseTokenAccount(after.owner, after.data) : null;
    const identity = postToken ?? preToken;
    if (!identity) return;
    const preAmount = preToken?.amount ?? 0n;
    const postAmount = postToken?.amount ?? 0n;
    if (preAmount === postAmount) return;
    mints.add(identity.mint);
    tokens.push({
      account: address,
      owner: identity.owner,
      mint: identity.mint,
      program: identity.program,
      pre: preAmount,
      post: postAmount,
      delta: postAmount - preAmount,
    });
  });

  return { sol, tokens, mints: [...mints] };
}
