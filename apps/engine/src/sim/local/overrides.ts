import type { Override } from "@soltracer/shared/simulation";
import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { parseMintDecimals, parseTokenAccount, TOKEN_2022_PROGRAM } from "../../decode/token-account.ts";
import type { AccountSnapshot } from "../../rpc/accounts.ts";

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
/** Wrapped SOL mints: their token accounts hold the balance as lamports. */
const NATIVE_MINTS = new Set<string>([
  "So11111111111111111111111111111111111111112",
  "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP",
]);
/** Token-2022 mint extensions whose token accounts need a matching account extension. */
const MINT_EXTENSIONS_NEEDING_ACCOUNT_EXTENSIONS = new Map<number, string>([
  [1, "TransferFeeConfig"],
  [9, "NonTransferable"],
  [14, "TransferHook"],
]);
const enc = getAddressEncoder();

/** An override that can't be applied; reported to the user as a validation error. */
export class OverrideError extends Error {
  override name = "OverrideError";
}

/** Rent-exempt minimum: (128 + data length) x 3480 lamports/byte-year x 2 years. */
export function rentExemptLamports(dataLength: number): bigint {
  return BigInt(128 + dataLength) * 3480n * 2n;
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Token-2022 mint extension types present in a mint's TLV area (after the 166-byte prefix). */
function mintExtensionTypes(mint: Uint8Array): number[] {
  const types: number[] = [];
  for (let offset = 166; offset + 4 <= mint.length; ) {
    const type = dv(mint).getUint16(offset, true);
    const length = dv(mint).getUint16(offset + 2, true);
    if (type === 0) break; // uninitialized padding
    types.push(type);
    offset += 4 + length;
  }
  return types;
}

/** Copy of a token account with a new amount; wrapped SOL also moves its lamports. */
function withAmount(account: AccountSnapshot, amount: bigint): AccountSnapshot {
  const data = account.data.slice();
  dv(data).setBigUint64(64, amount, true);
  const isNative = dv(data).getUint32(109, true) === 1;
  if (!isNative) return { ...account, data };
  const rentReserve = dv(data).getBigUint64(113, true);
  return { ...account, data, lamports: rentReserve + amount };
}

/** A fresh, initialized token account; Token-2022 associated accounts carry ImmutableOwner. */
function newTokenAccount(address: Address, program: Address, mint: Address, owner: Address, amount: bigint): AccountSnapshot {
  const is2022 = program === TOKEN_2022_PROGRAM;
  const data = new Uint8Array(is2022 ? 170 : 165);
  data.set(enc.encode(mint), 0);
  data.set(enc.encode(owner), 32);
  dv(data).setBigUint64(64, amount, true);
  data[108] = 1; // AccountState::Initialized
  const rent = rentExemptLamports(data.length);
  let lamports = rent;
  if (NATIVE_MINTS.has(mint)) {
    dv(data).setUint32(109, 1, true); // is_native: Some(rent reserve)
    dv(data).setBigUint64(113, rent, true);
    lamports = rent + amount;
  }
  if (is2022) {
    data[165] = 2; // AccountType::Account
    dv(data).setUint16(166, 7, true); // ExtensionType::ImmutableOwner, zero length
  }
  return { address, lamports, owner: program, executable: false, data };
}

/** Copy of the mint with supply moved by `change`, refusing to go below 0 or above u64. */
function withSupplyChange(mint: AccountSnapshot, change: bigint): AccountSnapshot {
  const data = mint.data.slice();
  const supply = dv(data).getBigUint64(36, true) + change;
  if (supply < 0n || supply > 0xffff_ffff_ffff_ffffn) {
    throw new OverrideError(`That amount would push the mint's supply out of range`);
  }
  dv(data).setBigUint64(36, supply, true);
  return { ...mint, data };
}

async function applyToken(
  accounts: Map<Address, AccountSnapshot | null>,
  o: Extract<Override, { kind: "token" }>,
): Promise<void> {
  const mintAddress = o.mint as Address;
  const owner = o.owner as Address;
  const mint = accounts.get(mintAddress);
  if (!mint || parseMintDecimals(mint.owner, mint.data) === null) {
    throw new OverrideError(`Mint ${o.mint} is not one of this transaction's accounts`);
  }
  const amount = BigInt(o.amount);
  const [ata] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [enc.encode(owner), enc.encode(mint.owner), enc.encode(mintAddress)],
  });

  // Prefer the owner's associated account, then any other account it holds for this mint.
  const candidates = [ata, ...[...accounts.keys()].filter((k) => k !== ata)];
  for (const address of candidates) {
    const account = accounts.get(address);
    const token = account ? parseTokenAccount(account.owner, account.data) : null;
    if (account && token && token.owner === owner && token.mint === mintAddress) {
      accounts.set(address, withAmount(account, amount));
      accounts.set(mintAddress, withSupplyChange(mint, amount - token.amount));
      return;
    }
  }

  if (accounts.get(ata)) throw new OverrideError(`${ata} already holds a different account`);
  if (mint.owner === TOKEN_2022_PROGRAM) {
    const blocking = mintExtensionTypes(mint.data).flatMap((t) => MINT_EXTENSIONS_NEEDING_ACCOUNT_EXTENSIONS.get(t) ?? []);
    if (blocking.length > 0) {
      throw new OverrideError(`Can't create a token account for this mint (${blocking.join(", ")}); override an existing one instead`);
    }
  }
  accounts.set(ata, newTokenAccount(ata, mint.owner, mintAddress, owner, amount));
  accounts.set(mintAddress, withSupplyChange(mint, amount));
}

function refuseSysvar(address: string): void {
  if (address.startsWith("Sysvar")) throw new OverrideError("Sysvar accounts can't be overridden");
}

/**
 * Applies overrides in order to a copy of the loaded state. Changed accounts get fresh data
 * buffers; unchanged accounts are shared with the input, so callers must treat data as read-only.
 */
export async function applyOverrides(
  loaded: ReadonlyMap<Address, AccountSnapshot | null>,
  overrides: readonly Override[],
): Promise<Map<Address, AccountSnapshot | null>> {
  const accounts = new Map(loaded);
  for (const o of overrides) {
    if (o.kind === "sol") {
      refuseSysvar(o.address);
      const address = o.address as Address;
      const current = accounts.get(address);
      accounts.set(
        address,
        current
          ? { ...current, lamports: BigInt(o.lamports) }
          : { address, lamports: BigInt(o.lamports), owner: SYSTEM_PROGRAM, executable: false, data: new Uint8Array() },
      );
    } else if (o.kind === "token") {
      await applyToken(accounts, o);
    } else {
      refuseSysvar(o.address);
      const address = o.address as Address;
      const current = accounts.get(address);
      const data = new Uint8Array(Buffer.from(o.dataBase64, "base64"));
      accounts.set(address, {
        address,
        data,
        owner: (o.owner as Address | undefined) ?? current?.owner ?? SYSTEM_PROGRAM,
        lamports: current?.lamports ?? rentExemptLamports(data.length),
        executable: current?.executable ?? false,
      });
    }
  }
  return accounts;
}
