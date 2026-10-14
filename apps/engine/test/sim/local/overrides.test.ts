import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { parseTokenAccount, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../../../src/decode/token-account.ts";
import type { AccountSnapshot } from "../../../src/rpc/accounts.ts";
import { applyOverrides, OverrideError, rentExemptLamports } from "../../../src/sim/local/overrides.ts";

const enc = getAddressEncoder();
const SYSTEM = address("11111111111111111111111111111111");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WALLET = address("AddressLookupTab1e1111111111111111111111111");
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const T22_MINT = address("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo");
const EXISTING = address("Stake11111111111111111111111111111111111111");
const WSOL = address("So11111111111111111111111111111111111111112");

function mintAccount(addr: Address, program: Address, decimals: number): AccountSnapshot {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return { address: addr, lamports: 1_461_600n, owner: program, executable: false, data };
}
function tokenAccount(addr: Address, mint: Address, owner: Address, amount: bigint): AccountSnapshot {
  const data = new Uint8Array(165);
  data.set(enc.encode(mint), 0);
  data.set(enc.encode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return { address: addr, lamports: 2_039_280n, owner: TOKEN_PROGRAM, executable: false, data };
}

const base = () =>
  new Map<Address, AccountSnapshot | null>([
    [WALLET, { address: WALLET, lamports: 10n, owner: SYSTEM, executable: false, data: new Uint8Array() }],
    [USDC, mintAccount(USDC, TOKEN_PROGRAM, 6)],
    [T22_MINT, mintAccount(T22_MINT, TOKEN_2022_PROGRAM, 9)],
    [EXISTING, tokenAccount(EXISTING, USDC, WALLET, 5n)],
    [WSOL, mintAccount(WSOL, TOKEN_PROGRAM, 9)],
  ]);

describe("applyOverrides", () => {
  it("sets a SOL balance, creating a system account when missing", async () => {
    const fresh = address("Config1111111111111111111111111111111111111");
    const out = await applyOverrides(base(), [
      { kind: "sol", address: WALLET, lamports: "5000000000" },
      { kind: "sol", address: fresh, lamports: "7" },
    ]);
    expect(out.get(WALLET)?.lamports).toBe(5_000_000_000n);
    expect(out.get(fresh)).toMatchObject({ lamports: 7n, owner: SYSTEM, executable: false });
  });

  it("sets the amount on the owner's existing token account for that mint", async () => {
    const out = await applyOverrides(base(), [{ kind: "token", owner: WALLET, mint: USDC, amount: "18446744073709551615" }]);
    const account = out.get(EXISTING);
    expect(account && parseTokenAccount(account.owner, account.data)).toMatchObject({ amount: 18_446_744_073_709_551_615n, owner: WALLET, mint: USDC });
  });

  it("creates the associated token account when the owner has none (SPL Token)", async () => {
    const accounts = base();
    accounts.delete(EXISTING);
    const out = await applyOverrides(accounts, [{ kind: "token", owner: WALLET, mint: USDC, amount: "1000000" }]);
    const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(WALLET), enc.encode(TOKEN_PROGRAM), enc.encode(USDC)] });
    const created = out.get(ata);
    expect(created).toMatchObject({ owner: TOKEN_PROGRAM, lamports: rentExemptLamports(165) });
    expect(created && parseTokenAccount(created.owner, created.data)).toMatchObject({ amount: 1_000_000n, owner: WALLET, mint: USDC });
  });

  it("creates a Token-2022 associated account with the ImmutableOwner extension", async () => {
    const out = await applyOverrides(base(), [{ kind: "token", owner: WALLET, mint: T22_MINT, amount: "42" }]);
    const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(WALLET), enc.encode(TOKEN_2022_PROGRAM), enc.encode(T22_MINT)] });
    const created = out.get(ata);
    expect(created?.data.length).toBe(170);
    expect(created?.data[165]).toBe(2); // AccountType::Account
    expect(created && parseTokenAccount(created.owner, created.data)).toMatchObject({ amount: 42n, program: "token-2022" });
  });

  it("replaces raw data, optionally the owner, and keeps the lamports", async () => {
    const out = await applyOverrides(base(), [{ kind: "data", address: WALLET, dataBase64: "AQID", owner: TOKEN_PROGRAM }]);
    expect(out.get(WALLET)).toMatchObject({ lamports: 10n, owner: TOKEN_PROGRAM, data: new Uint8Array([1, 2, 3]) });
  });

  it("does not mutate the input map or its accounts", async () => {
    const accounts = base();
    const before = accounts.get(EXISTING)?.data.slice();
    await applyOverrides(accounts, [{ kind: "token", owner: WALLET, mint: USDC, amount: "9" }]);
    expect(accounts.get(EXISTING)?.data).toEqual(before);
  });

  it("keeps the mint's supply consistent with the new balance", async () => {
    const out = await applyOverrides(base(), [{ kind: "token", owner: WALLET, mint: USDC, amount: "105" }]);
    const mint = out.get(USDC);
    expect(mint && new DataView(mint.data.buffer, mint.data.byteOffset).getBigUint64(36, true)).toBe(100n);
  });

  it("creates wrapped SOL as a native account whose lamports hold the balance", async () => {
    const out = await applyOverrides(base(), [{ kind: "token", owner: WALLET, mint: WSOL, amount: "1000000000" }]);
    const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(WALLET), enc.encode(TOKEN_PROGRAM), enc.encode(WSOL)] });
    const created = out.get(ata);
    const v = created && new DataView(created.data.buffer, created.data.byteOffset);
    expect(v?.getUint32(109, true)).toBe(1); // is_native: Some
    expect(v?.getBigUint64(113, true)).toBe(rentExemptLamports(165));
    expect(created?.lamports).toBe(rentExemptLamports(165) + 1_000_000_000n);
  });

  it("moves an existing wrapped SOL account's lamports with its amount", async () => {
    const accounts = base();
    const native = tokenAccount(EXISTING, WSOL, WALLET, 5n);
    new DataView(native.data.buffer).setUint32(109, 1, true);
    new DataView(native.data.buffer).setBigUint64(113, 2_039_280n, true);
    accounts.set(EXISTING, { ...native, lamports: 2_039_285n });
    const out = await applyOverrides(accounts, [{ kind: "token", owner: WALLET, mint: WSOL, amount: "700" }]);
    expect(out.get(EXISTING)?.lamports).toBe(2_039_980n);
  });

  it("refuses to create accounts for Token-2022 mints whose accounts need extensions", async () => {
    const accounts = base();
    const mint = new Uint8Array(170 + 108);
    mint[44] = 9;
    mint[45] = 1;
    mint[165] = 1; // AccountType::Mint
    new DataView(mint.buffer).setUint16(166, 1, true); // TransferFeeConfig
    new DataView(mint.buffer).setUint16(168, 108, true);
    accounts.set(T22_MINT, { address: T22_MINT, lamports: 1n, owner: TOKEN_2022_PROGRAM, executable: false, data: mint });
    await expect(applyOverrides(accounts, [{ kind: "token", owner: WALLET, mint: T22_MINT, amount: "1" }])).rejects.toThrow(/TransferFeeConfig/);
  });

  it("refuses supply overflow and sysvar targets", async () => {
    const accounts = base();
    const mint = accounts.get(USDC);
    if (mint) new DataView(mint.data.buffer).setBigUint64(36, 0xffff_ffff_ffff_fff0n, true);
    await expect(applyOverrides(accounts, [{ kind: "token", owner: WALLET, mint: USDC, amount: "1000" }])).rejects.toThrow(OverrideError);
    await expect(applyOverrides(base(), [{ kind: "sol", address: "SysvarC1ock11111111111111111111111111111111", lamports: "1" }])).rejects.toThrow(/Sysvar/);
  });

  it("refuses a token override for a mint the transaction does not touch", async () => {
    const unknown = address("Vote111111111111111111111111111111111111111");
    await expect(applyOverrides(base(), [{ kind: "token", owner: WALLET, mint: unknown, amount: "1" }])).rejects.toThrow(OverrideError);
  });
});
