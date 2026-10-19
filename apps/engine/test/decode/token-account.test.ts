import { address, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  parseMintDecimals,
  parseTokenAccount,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "../../src/decode/token-account.ts";

const enc = getAddressEncoder();
const MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OWNER = address("SysvarRent111111111111111111111111111111111");

/** SPL token account: mint(32) owner(32) amount(u64) delegate(36) state(1 @108) ... = 165 bytes. */
function tokenAccount(amount: bigint, opts: { state?: number; extraType?: number } = {}): Uint8Array {
  const data = new Uint8Array(opts.extraType === undefined ? 165 : 170);
  data.set(enc.encode(MINT), 0);
  data.set(enc.encode(OWNER), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = opts.state ?? 1;
  if (opts.extraType !== undefined) data[165] = opts.extraType;
  return data;
}

/** Mint: mint_authority(36) supply(8) decimals(1 @44) is_initialized(1 @45) freeze(36) = 82 bytes. */
function mint(decimals: number, opts: { initialized?: boolean; extended?: boolean } = {}): Uint8Array {
  const data = new Uint8Array(opts.extended ? 200 : 82);
  data[44] = decimals;
  data[45] = opts.initialized === false ? 0 : 1;
  if (opts.extended) data[165] = 1;
  return data;
}

describe("parseTokenAccount", () => {
  it("reads mint, owner and a u64 amount beyond 2^53", () => {
    const amount = 18_446_744_073_709_551_615n;
    expect(parseTokenAccount(TOKEN_PROGRAM, tokenAccount(amount))).toEqual({
      mint: MINT,
      owner: OWNER,
      amount,
      program: "token",
    });
  });

  it("reads Token-2022 accounts with extensions and frozen accounts", () => {
    expect(parseTokenAccount(TOKEN_2022_PROGRAM, tokenAccount(5n, { extraType: 2 }))).toMatchObject({
      amount: 5n,
      program: "token-2022",
    });
    expect(parseTokenAccount(TOKEN_PROGRAM, tokenAccount(5n, { state: 2 }))?.amount).toBe(5n);
  });

  it("returns null for other owners, uninitialized accounts, mints and wrong sizes", () => {
    expect(parseTokenAccount(address("11111111111111111111111111111111"), tokenAccount(1n))).toBeNull();
    expect(parseTokenAccount(TOKEN_PROGRAM, tokenAccount(1n, { state: 0 }))).toBeNull();
    expect(parseTokenAccount(TOKEN_PROGRAM, tokenAccount(1n, { extraType: 2 }))).toBeNull();
    expect(parseTokenAccount(TOKEN_2022_PROGRAM, tokenAccount(1n, { extraType: 1 }))).toBeNull();
    expect(parseTokenAccount(TOKEN_PROGRAM, new Uint8Array(100))).toBeNull();
    const multisig = new Uint8Array(355);
    multisig[108] = 1;
    multisig[165] = 2;
    expect(parseTokenAccount(TOKEN_2022_PROGRAM, multisig)).toBeNull();
    multisig[165] = 1;
    multisig[45] = 1;
    expect(parseMintDecimals(TOKEN_2022_PROGRAM, multisig)).toBeNull();
  });
});

describe("parseMintDecimals", () => {
  it("reads decimals from SPL and extended Token-2022 mints", () => {
    expect(parseMintDecimals(TOKEN_PROGRAM, mint(6))).toBe(6);
    expect(parseMintDecimals(TOKEN_2022_PROGRAM, mint(9, { extended: true }))).toBe(9);
  });

  it("returns null for uninitialized mints, token accounts and other owners", () => {
    expect(parseMintDecimals(TOKEN_PROGRAM, mint(6, { initialized: false }))).toBeNull();
    expect(parseMintDecimals(TOKEN_PROGRAM, tokenAccount(1n))).toBeNull();
    expect(parseMintDecimals(TOKEN_PROGRAM, mint(6, { extended: true }))).toBeNull();
    expect(parseMintDecimals(address("11111111111111111111111111111111"), mint(6))).toBeNull();
  });
});
