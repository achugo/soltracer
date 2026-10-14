import {
  address,
  appendTransactionMessageInstruction,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Address,
} from "@solana/kit";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { addedBudgetCost, messageInvariants, nonBudgetInstructions, rewriteTransaction } from "../../src/optimize/rewrite.ts";
import { readComputeBudget } from "../../src/tx/compute-budget.ts";
import { decodeTransactionInput, type DecodedTransaction } from "../../src/tx/decode.ts";
import { resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { loadOnChain, tablesFromMeta, type SandboxFixtureName } from "../helpers/sandbox-fixtures.ts";

const FRESH = { blockhash: bs58.encode(new Uint8Array(32).fill(4)), lastValidBlockHeight: 300_000_150n };

function decode(wire: string): DecodedTransaction {
  const res = decodeTransactionInput(wire);
  if (!res.ok) throw new Error(res.error.message);
  return res.tx;
}

function fixture(name: SandboxFixtureName) {
  const fx = loadOnChain(name);
  const tx = decode(fx.transaction[0]);
  const tables = tablesFromMeta(tx.lookups, fx);
  return { tx, tables, accounts: resolveAccounts(tx, tables) };
}

/** Rewrites, decodes the result back and resolves it against the same tables. */
function roundTrip(name: SandboxFixtureName, limit: number, price: bigint) {
  const { tx, tables, accounts } = fixture(name);
  const out = rewriteTransaction({ tx, accounts, limit, priceMicroLamports: price, lifetime: FRESH });
  if (!out.ok) throw new Error(out.error.message);
  const next = decode(out.wireBase64);
  const nextAccounts = resolveAccounts(next, tables);
  return { before: { tx, accounts }, after: { tx: next, accounts: nextAccounts }, out };
}

describe("rewriteTransaction", () => {
  it("inserts budget instructions into a transaction that had none (SOL transfer)", () => {
    const { before, after } = roundTrip("sol-transfer", 173, 25_000n);
    expect(readComputeBudget(after.tx, after.accounts)).toMatchObject({
      limit: 173,
      limitSource: "explicit",
      priceMicroLamports: "25000",
      priorityFeeLamports: "5", // ceil(173 x 25000 / 1e6)
    });
    expect(nonBudgetInstructions(after.tx, after.accounts)).toEqual(nonBudgetInstructions(before.tx, before.accounts));
  });

  it("replaces existing budget instructions and keeps lookup tables (Jupiter v0)", () => {
    const { before, after, out } = roundTrip("jupiter-swap-alt", 110_651, 50_000n);
    expect(readComputeBudget(after.tx, after.accounts)).toMatchObject({ limit: 110_651, priceMicroLamports: "50000" });
    expect(after.tx.version).toBe(0);
    expect(after.tx.lookups.map((l) => l.table).sort()).toEqual(before.tx.lookups.map((l) => l.table).sort());
    expect(after.accounts.filter((a) => a.source.kind === "lookup").length).toBe(
      before.accounts.filter((a) => a.source.kind === "lookup").length,
    );
    expect(nonBudgetInstructions(after.tx, after.accounts)).toEqual(nonBudgetInstructions(before.tx, before.accounts));
    expect(out.size).toBeLessThanOrEqual(1232);
  });

  it("keeps instructions it does not manage, like the loaded-accounts data limit", () => {
    const { after } = roundTrip("jupiter-slippage-6001", 71_323, 1_000n);
    expect(readComputeBudget(after.tx, after.accounts).loadedAccountsDataSizeLimit).toBe(14_371_902);
  });

  it("rewrites a v1 config: limit and total priority fee, keeping the data limit", () => {
    const { before, after } = roundTrip("v1-transaction", 134_446, 10_000n);
    expect(after.tx.version).toBe(1);
    expect(readComputeBudget(after.tx, after.accounts)).toEqual({
      limit: 134_446,
      limitSource: "explicit",
      defaultLimit: 200_000,
      priceMicroLamports: null,
      priorityFeeLamports: "1345", // ceil(134446 x 10000 / 1e6)
      loadedAccountsDataSizeLimit: 35_000_000,
    });
    expect(nonBudgetInstructions(after.tx, after.accounts)).toEqual(nonBudgetInstructions(before.tx, before.accounts));
  });

  it("sets the fresh blockhash and clears every signature", () => {
    const { before, after } = roundTrip("jupiter-swap-alt", 110_651, 50_000n);
    expect(before.tx.signed).toBe(true);
    expect(after.tx.signed).toBe(false);
    expect(after.tx.compiled.lifetimeToken).toBe(FRESH.blockhash);
  });

  it("keeps a durable nonce lifetime instead of replacing it", () => {
    const nonce = address("SysvarRent111111111111111111111111111111111");
    const authority = address("11111111111111111111111111111112");
    const nonceValue = "4vJ9JU1bJJE96FWSJKvHsmPNuC6VWS3Gr1ywwnYASBqq";
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(authority, m),
      (m) => setTransactionMessageLifetimeUsingDurableNonce(
        { nonce: nonceValue as never, nonceAccountAddress: nonce, nonceAuthorityAddress: authority },
        m,
      ),
      (m) => appendTransactionMessageInstruction({ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: new Uint8Array([1, 2, 3]) }, m),
    );
    const tx = decode(getBase64EncodedWireTransaction(compileTransaction(message)));
    const out = rewriteTransaction({ tx, accounts: resolveAccounts(tx, new Map()), limit: 5_000, priceMicroLamports: 1n, lifetime: FRESH });
    if (!out.ok) throw new Error(out.error.message);
    expect(out.durableNonce).toBe(true);
    expect(decode(out.wireBase64).compiled.lifetimeToken).toBe(nonceValue);
  });

  it("adds no price instruction when the fee is zero and removes an existing one", () => {
    const zeroOnTransfer = roundTrip("sol-transfer", 173, 0n);
    expect(zeroOnTransfer.after.tx.compiled.version === 0 && zeroOnTransfer.after.tx.compiled.instructions.length).toBe(2);
    const zeroOnSwap = roundTrip("jupiter-swap-alt", 110_651, 0n);
    expect(readComputeBudget(zeroOnSwap.after.tx, zeroOnSwap.after.accounts)).toMatchObject({ priceMicroLamports: "0", priorityFeeLamports: "0" });
  });

  it("rejects an invalid limit without throwing", () => {
    const { tx, accounts } = fixture("sol-transfer");
    for (const limit of [0, 1.5, 1_400_001]) {
      const out = rewriteTransaction({ tx, accounts, limit, priceMicroLamports: 1n, lifetime: FRESH });
      expect(out.ok).toBe(false);
    }
  });

  it("refuses a rewrite that no longer fits the size limit", () => {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address("11111111111111111111111111111112"), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: toBlockhash(FRESH.blockhash), lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstruction({ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: new Uint8Array(1_040) }, m),
    );
    const tx = decode(getBase64EncodedWireTransaction(compileTransaction(message)));
    expect(tx.size).toBeLessThanOrEqual(1232);
    const out = rewriteTransaction({ tx, accounts: resolveAccounts(tx, new Map()), limit: 5_000, priceMicroLamports: 1n, lifetime: FRESH });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("TX_TOO_LARGE");
  });
});

describe("messageInvariants", () => {
  it.each(["sol-transfer", "jupiter-swap-alt", "jupiter-slippage-6001", "v1-transaction"] as const)(
    "are unchanged by a rewrite of %s (fee payer, signers, writable set, untouched instructions)",
    (name) => {
      const { before, after } = roundTrip(name, 100_000, 7_000n);
      expect(messageInvariants(after.tx, after.accounts)).toEqual(messageInvariants(before.tx, before.accounts));
    },
  );

  it("keeps other ComputeBudget instructions, like the loaded-accounts data limit, in the comparison", () => {
    const { tx, accounts } = fixture("jupiter-slippage-6001");
    const kept = messageInvariants(tx, accounts).instructions.filter(
      (ix) => ix.programAddress === ("ComputeBudget111111111111111111111111111111" as Address),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.data.startsWith("04")).toBe(true); // SetLoadedAccountsDataSizeLimit
  });

  it("would notice a changed fee payer or an escalated account", () => {
    const { tx, accounts } = fixture("jupiter-swap-alt");
    const base = messageInvariants(tx, accounts);
    const escalated = accounts.map((a, i) => (i === accounts.length - 1 ? { ...a, writable: true } : a));
    expect(messageInvariants(tx, escalated).writable).not.toEqual(base.writable);
    const otherPayer = [accounts[1], accounts[0], ...accounts.slice(2)].filter((a) => a !== undefined);
    expect(messageInvariants(tx, otherPayer).feePayer).not.toBe(base.feePayer);
  });
});

describe("addedBudgetCost", () => {
  it("charges 150 CU for each limit/price instruction a legacy or v0 rewrite adds", () => {
    expect(addedBudgetCost(fixture("sol-transfer").tx, fixture("sol-transfer").accounts)).toBe(300);
    expect(addedBudgetCost(fixture("jupiter-swap-alt").tx, fixture("jupiter-swap-alt").accounts)).toBe(0);
  });

  it("charges nothing for v1, whose budget lives in the message config", () => {
    expect(addedBudgetCost(fixture("v1-transaction").tx, fixture("v1-transaction").accounts)).toBe(0);
  });
});

describe("nonBudgetInstructions", () => {
  it("lists program, accounts with roles and data, skipping ComputeBudget", () => {
    const { tx, accounts } = fixture("jupiter-swap-alt");
    const list = nonBudgetInstructions(tx, accounts);
    expect(list).toHaveLength(5);
    expect(list.every((ix) => ix.programAddress !== ("ComputeBudget111111111111111111111111111111" as Address))).toBe(true);
    expect(list[0]).toMatchObject({ programAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" });
  });
});
