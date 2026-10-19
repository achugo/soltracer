import { address, getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { decodeTransactionInput, type DecodedTransaction } from "../../src/tx/decode.ts";
import { LookupTableError, parseLookupTable, resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { loadOnChain, tablesFromMeta as rebuild, type OnChainTx } from "../helpers/sandbox-fixtures.ts";

const tablesFromMeta = (tx: DecodedTransaction, fx: OnChainTx) => rebuild(tx.lookups, fx);

const encoder = getAddressEncoder();
const FILLER = address("11111111111111111111111111111111");

/** Lookup-table account bytes: 56-byte header, then 32-byte addresses. */
function tableData(addresses: readonly Address[]): Uint8Array {
  const data = new Uint8Array(56 + 32 * addresses.length);
  addresses.forEach((a, i) => data.set(encoder.encode(a), 56 + 32 * i));
  return data;
}

function decode(fx: OnChainTx): DecodedTransaction {
  const res = decodeTransactionInput(fx.transaction[0]);
  if (!res.ok) throw new Error(res.error.message);
  return res.tx;
}

describe("parseLookupTable", () => {
  it("reads the addresses after the 56-byte header", () => {
    const addrs = [address("SysvarRent111111111111111111111111111111111"), FILLER];
    expect(parseLookupTable(tableData(addrs))).toEqual(addrs);
    expect(parseLookupTable(tableData([]))).toEqual([]);
  });

  it("rejects truncated or misaligned data", () => {
    expect(() => parseLookupTable(new Uint8Array(55))).toThrow(LookupTableError);
    expect(() => parseLookupTable(new Uint8Array(56 + 31))).toThrow(LookupTableError);
  });
});

describe("resolveAccounts", () => {
  it("lists every account of a lookup-table transaction in runtime order, matching on-chain loadedAddresses", () => {
    const fx = loadOnChain("jupiter-swap-alt");
    const tx = decode(fx);
    const accounts = resolveAccounts(tx, tablesFromMeta(tx, fx));
    const loaded = fx.meta.loadedAddresses ?? { writable: [], readonly: [] };

    expect(accounts.map((a) => a.address)).toEqual([...tx.staticAccounts, ...loaded.writable, ...loaded.readonly]);
    expect(accounts).toHaveLength(fx.meta.preBalances.length);

    const lookedUp = accounts.slice(tx.staticAccounts.length);
    expect(lookedUp.every((a) => a.source.kind === "lookup" && !a.signer)).toBe(true);
    expect(lookedUp.slice(0, loaded.writable.length).every((a) => a.writable)).toBe(true);
    expect(lookedUp.slice(loaded.writable.length).every((a) => !a.writable)).toBe(true);
  });

  it("derives signer and writable flags for static accounts from the header", () => {
    const fx = loadOnChain("jupiter-swap-alt");
    const tx = decode(fx);
    const statics = resolveAccounts(tx, tablesFromMeta(tx, fx)).slice(0, tx.staticAccounts.length);
    const { numSignerAccounts: s, numReadonlySignerAccounts: rs, numReadonlyNonSignerAccounts: rn } = tx.header;
    const n = tx.staticAccounts.length;
    statics.forEach((a, i) => {
      expect(a.signer).toBe(i < s);
      expect(a.writable).toBe(i < s ? i < s - rs : i < n - rn);
      expect(a.source).toEqual({ kind: "static" });
    });
    expect(statics[0]?.signer && statics[0].writable).toBe(true);
  });

  it("needs no tables for v1 and static-only transactions", () => {
    for (const name of ["v1-transaction", "sol-transfer"] as const) {
      const fx = loadOnChain(name);
      const tx = decode(fx);
      expect(resolveAccounts(tx, new Map()).map((a) => a.address)).toEqual(tx.staticAccounts);
    }
  });

  it("fails clearly when a table is missing or too short", () => {
    const fx = loadOnChain("jupiter-swap-alt");
    const tx = decode(fx);
    expect(() => resolveAccounts(tx, new Map())).toThrow(/lookup table .* not loaded/i);
    const short = new Map([...tablesFromMeta(tx, fx)].map(([k, v]) => [k, v.slice(0, 1)]));
    expect(() => resolveAccounts(tx, short)).toThrow(/index \d+ .* has \d+ entries/i);
  });
});
