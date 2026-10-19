import { describe, expect, it } from "vitest";
import { decodeTransactionInput } from "../../src/tx/decode.ts";
import { readComputeBudget } from "../../src/tx/compute-budget.ts";
import { resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { loadOnChain, tablesFromMeta, type SandboxFixtureName } from "../helpers/sandbox-fixtures.ts";

function budgetOf(name: SandboxFixtureName) {
  const fx = loadOnChain(name);
  const res = decodeTransactionInput(fx.transaction[0]);
  if (!res.ok) throw new Error(res.error.message);
  const tables = tablesFromMeta(res.tx.lookups, fx);
  return { budget: readComputeBudget(res.tx, resolveAccounts(res.tx, tables)), fx, tx: res.tx };
}

/** Base fee is 5000 lamports per signature; priority fee must make up the rest of the on-chain fee. */
function expectFeeMatchesChain(name: SandboxFixtureName) {
  const { budget, fx, tx } = budgetOf(name);
  expect(5000 * tx.numSignatures + Number(budget.priorityFeeLamports)).toBe(fx.meta.fee);
}

describe("readComputeBudget", () => {
  it("uses the default limit when none is set (sol transfer)", () => {
    const { budget } = budgetOf("sol-transfer");
    expect(budget).toEqual({
      limit: 200_000,
      limitSource: "default",
      defaultLimit: 200_000,
      priceMicroLamports: "0",
      priorityFeeLamports: "0",
      loadedAccountsDataSizeLimit: null,
    });
  });

  it("reads SetComputeUnitLimit and SetComputeUnitPrice (Jupiter v0)", () => {
    const { budget } = budgetOf("jupiter-swap-alt");
    expect(budget).toMatchObject({
      limit: 132_811,
      limitSource: "explicit",
      defaultLimit: 1_000_000,
      priceMicroLamports: "17929",
      priorityFeeLamports: "2382",
    });
  });

  it("reads SetLoadedAccountsDataSizeLimit and rounds the priority fee up", () => {
    const { budget } = budgetOf("jupiter-slippage-6001");
    expect(budget).toMatchObject({
      limit: 68_548,
      priceMicroLamports: "2710071",
      priorityFeeLamports: "185770",
      loadedAccountsDataSizeLimit: 14_371_902,
    });
  });

  it("reads the v1 config: limit, total priority fee and loaded data limit", () => {
    const { budget } = budgetOf("v1-transaction");
    expect(budget).toEqual({
      limit: 325_428,
      limitSource: "explicit",
      defaultLimit: 200_000,
      priceMicroLamports: null,
      priorityFeeLamports: "241",
      loadedAccountsDataSizeLimit: 35_000_000,
    });
  });

  it.each(["sol-transfer", "jupiter-swap-alt", "jupiter-slippage-6001", "token-2022-transfer", "v1-transaction"] as const)(
    "reproduces the on-chain fee for %s",
    (name) => expectFeeMatchesChain(name),
  );
});
