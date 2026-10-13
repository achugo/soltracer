import type { SimulationResult, SolBalance, TokenBalance } from "@soltracer/shared/simulation";

export interface OwnerBalances {
  owner: string;
  isFeePayer: boolean;
  /** The owner's own lamport change, when its account was tracked. */
  sol: SolBalance | null;
  tokens: TokenBalance[];
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Groups SOL and token deltas under one entry per owner. A SOL row's owner is its address.
 * Order: the fee payer first (when present), then by largest absolute SOL change, then by first
 * appearance. Token rows keep their input order within an owner.
 */
export function groupBalances(
  balances: SimulationResult["balances"],
  feePayer: string | null,
): OwnerBalances[] {
  const groups = new Map<string, OwnerBalances>();
  const group = (owner: string) => {
    let g = groups.get(owner);
    if (!g) {
      g = { owner, isFeePayer: owner === feePayer, sol: null, tokens: [] };
      groups.set(owner, g);
    }
    return g;
  };

  for (const row of balances.sol) group(row.address).sol = row;
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
