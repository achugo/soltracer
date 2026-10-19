import { describe, expect, it } from "vitest";
import { walletDeltas, type BalanceMeta } from "../../src/stream/deltas.ts";
import { decodeTransactionInput } from "../../src/tx/decode.ts";
import { loadOnChain } from "../helpers/sandbox-fixtures.ts";
import { loadStreamFixture } from "../helpers/stream-fixtures.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function keysOf(wire: string, loaded?: { writable: string[]; readonly: string[] }): string[] {
  const decoded = decodeTransactionInput(wire);
  if (!decoded.ok) throw new Error(decoded.error.message);
  return [...decoded.tx.staticAccounts, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

describe("walletDeltas on recorded mainnet transactions", () => {
  it("jupiter-usdc-input: the fee payer pays SOL and spends USDC", () => {
    const fx = loadOnChain("jupiter-usdc-input");
    const keys = keysOf(fx.transaction[0], fx.meta.loadedAddresses);
    const payer = keys[0] ?? "";
    const deltas = walletDeltas(payer, keys, fx.meta as unknown as BalanceMeta);
    expect(BigInt(deltas.sol?.delta ?? "0")).toBeLessThan(0n);
    const usdc = deltas.tokens.find((t) => t.mint === USDC);
    expect(usdc).toMatchObject({ owner: payer, program: "token", decimals: 6 });
    const pre = fx.meta.preTokenBalances.find((b) => b.mint === USDC && b.owner === payer);
    const post = fx.meta.postTokenBalances.find((b) => b.mint === USDC && b.owner === payer);
    expect([usdc?.pre, usdc?.post]).toEqual([pre?.uiTokenAmount.amount, post?.uiTokenAmount.amount]);
    expect(BigInt(usdc?.delta ?? "0")).toBeLessThan(0n);
  });

  it("a wallet the transaction doesn't touch has no changes", () => {
    const fx = loadOnChain("jupiter-usdc-input");
    const keys = keysOf(fx.transaction[0], fx.meta.loadedAddresses);
    expect(walletDeltas("Vote111111111111111111111111111111111111111", keys, fx.meta as unknown as BalanceMeta)).toEqual({ sol: null, tokens: [] });
  });

  it("the recorded stream's transactions: only balances that moved, all owned by the wallet", () => {
    const stream = loadStreamFixture("jupiter-mentions");
    for (const record of stream.rpc.filter((r) => r.method === "getTransaction")) {
      const result = (record.response as { result: { transaction: [string]; meta: BalanceMeta & { loadedAddresses: { writable: string[]; readonly: string[] } } } }).result;
      const keys = keysOf(result.transaction[0], result.meta.loadedAddresses);
      const deltas = walletDeltas(keys[0] ?? "", keys, result.meta);
      for (const t of deltas.tokens) {
        expect(t.owner).toBe(keys[0]);
        expect(t.delta).not.toBe("0");
      }
      if (deltas.sol) expect(deltas.sol.delta).not.toBe("0");
    }
  });

  it("a created token account counts from zero, a closed one to zero", () => {
    const wallet = "Vote111111111111111111111111111111111111111";
    const keys = [wallet, "Stake11111111111111111111111111111111111111", "Config1111111111111111111111111111111111111"];
    const bal = (accountIndex: number, amount: string) => ({ accountIndex, mint: USDC, owner: wallet, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", uiTokenAmount: { amount, decimals: 6 } });
    const deltas = walletDeltas(wallet, keys, {
      preBalances: [1n, 0n, 0n],
      postBalances: [1n, 0n, 0n],
      preTokenBalances: [bal(2, "7")],
      postTokenBalances: [bal(1, "5")],
    });
    expect(deltas.sol).toBeNull();
    expect(deltas.tokens.map((t) => [t.account, t.pre, t.post, t.delta])).toEqual([
      [keys[1], "0", "5", "5"],
      [keys[2], "7", "0", "-7"],
    ]);
  });
});
