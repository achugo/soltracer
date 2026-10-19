import type { SimulationResult, SolBalance, TokenBalance } from "@soltracer/shared/simulation";

/** Lamport change on a token account (rent on create or close, or unwrapped WSOL). */
export interface TokenAccountSol {
  account: string;
  sol: SolBalance;
}

export interface OwnerBalances {
  owner: string;
  isFeePayer: boolean;
  /** The owner's own lamport change, when its account was tracked. */
  sol: SolBalance | null;
  /** Lamport changes on token accounts this owner holds, folded in from the SOL rows. */
  tokenAccountSol: TokenAccountSol[];
  tokens: TokenBalance[];
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Groups SOL and token deltas under one entry per owner. A SOL row's owner is its address, except
 * when that address is a token account in `tokens`: then it joins the token account owner's group as
 * token-account SOL (created or closed ATAs, unwrapped WSOL). Only token accounts whose token amount
 * changed appear in `tokens`, so an empty token account keeps its own group.
 *
 * Order: the fee payer first (when present), then by largest absolute change in the owner's own SOL,
 * then by first appearance. Rows keep their input order within an owner.
 */
export function groupBalances(
  balances: SimulationResult["balances"],
  feePayer: string | null,
): OwnerBalances[] {
  const tokenOwner = new Map(balances.tokens.map((t) => [t.account, t.owner]));
  const groups = new Map<string, OwnerBalances>();
  const group = (owner: string) => {
    let g = groups.get(owner);
    if (!g) {
      g = { owner, isFeePayer: owner === feePayer, sol: null, tokenAccountSol: [], tokens: [] };
      groups.set(owner, g);
    }
    return g;
  };

  for (const row of balances.sol) {
    const owner = tokenOwner.get(row.address);
    if (owner === undefined) group(row.address).sol = row;
    else group(owner).tokenAccountSol.push({ account: row.address, sol: row });
  }
  for (const row of balances.tokens) group(row.owner).tokens.push(row);

  const solChange = (g: OwnerBalances) => (g.sol ? abs(BigInt(g.sol.delta)) : 0n);
  // Array.prototype.sort is stable, so ties keep first-appearance order.
  return [...groups.values()].sort((a, b) => {
    if (a.isFeePayer !== b.isFeePayer) return a.isFeePayer ? -1 : 1;
    const da = solChange(a);
    const db = solChange(b);
    return da === db ? 0 : da > db ? -1 : 1;
  });
}
