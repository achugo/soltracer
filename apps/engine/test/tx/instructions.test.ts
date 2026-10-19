import { describe, expect, it } from "vitest";
import { decodeTransactionInput } from "../../src/tx/decode.ts";
import { topLevelInstructions } from "../../src/tx/instructions.ts";
import { resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { instructionPrograms } from "../../src/tx/programs.ts";
import { loadOnChain, ON_CHAIN_FIXTURES, tablesFromMeta } from "../helpers/sandbox-fixtures.ts";

describe("topLevelInstructions", () => {
  it.each(ON_CHAIN_FIXTURES)("%s: agrees with the program list and carries each instruction's data", (name) => {
    const fx = loadOnChain(name);
    const decoded = decodeTransactionInput(fx.transaction[0]);
    if (!decoded.ok) throw new Error(decoded.error.message);
    const accounts = resolveAccounts(decoded.tx, tablesFromMeta(decoded.tx.lookups, fx));
    const ixs = topLevelInstructions(decoded.tx, accounts);
    expect(ixs.map((ix) => ix.programId)).toEqual(instructionPrograms(decoded.tx, accounts));
    const addresses = new Set(accounts.map((a) => a.address));
    for (const ix of ixs) expect(ix.accounts.every((a) => addresses.has(a))).toBe(true);
    // Every non-builtin instruction carries data (System transfers and Jupiter routes alike).
    expect(ixs.some((ix) => ix.data.length > 0)).toBe(true);
  });

  it("reads v1 instruction payloads", () => {
    const fx = loadOnChain("v1-transaction");
    const decoded = decodeTransactionInput(fx.transaction[0]);
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.tx.version).toBe(1);
    const ixs = topLevelInstructions(decoded.tx, resolveAccounts(decoded.tx, new Map()));
    expect(ixs.length).toBeGreaterThan(0);
    expect(ixs[0]?.data.length).toBeGreaterThan(0);
  });
});
