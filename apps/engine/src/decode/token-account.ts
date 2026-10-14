import { getAddressDecoder, type Address } from "@solana/kit";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** Base token account and mint sizes; Token-2022 appends an account-type byte at 165, then extensions. */
const ACCOUNT_SIZE = 165;
const MINT_SIZE = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;
/** Multisig accounts are 355 bytes; their signer keys can look like a type byte at 165. */
const MULTISIG_SIZE = 355;

export interface TokenAccountState {
  mint: Address;
  owner: Address;
  amount: bigint;
  program: "token" | "token-2022";
}

const addressDecoder = getAddressDecoder();

function programKind(owner: Address): "token" | "token-2022" | null {
  if (owner === TOKEN_PROGRAM) return "token";
  if (owner === TOKEN_2022_PROGRAM) return "token-2022";
  return null;
}

function isAccountLayout(kind: "token" | "token-2022", data: Uint8Array): boolean {
  if (data.length === ACCOUNT_SIZE) return true;
  return (
    kind === "token-2022" &&
    data.length > ACCOUNT_SIZE &&
    data.length !== MULTISIG_SIZE &&
    data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_ACCOUNT
  );
}

function isMintLayout(kind: "token" | "token-2022", data: Uint8Array): boolean {
  if (data.length === MINT_SIZE) return true;
  return (
    kind === "token-2022" &&
    data.length > ACCOUNT_SIZE &&
    data.length !== MULTISIG_SIZE &&
    data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT
  );
}

/** Decodes an initialized SPL Token or Token-2022 account; null for anything else. */
export function parseTokenAccount(owner: Address, data: Uint8Array): TokenAccountState | null {
  const kind = programKind(owner);
  if (!kind || !isAccountLayout(kind, data)) return null;
  const state = data[108];
  if (state !== 1 && state !== 2) return null; // 1 initialized, 2 frozen
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: addressDecoder.decode(data.subarray(0, 32)),
    owner: addressDecoder.decode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
    program: kind,
  };
}

/** Decimals of an initialized SPL Token or Token-2022 mint; null for anything else. */
export function parseMintDecimals(owner: Address, data: Uint8Array): number | null {
  const kind = programKind(owner);
  if (!kind || !isMintLayout(kind, data) || data[45] !== 1) return null;
  return data[44] ?? null;
}

const ACCOUNT_STATES = ["uninitialized", "initialized", "frozen"] as const;

/** COption<Pubkey>: a u32 tag, then 32 bytes. */
function optionalAddress(data: Uint8Array, at: number): Address | null {
  return data[at] === 1 ? addressDecoder.decode(data.subarray(at + 4, at + 36)) : null;
}

/** Every base field of an SPL Token or Token-2022 account (extensions are not decoded); null if not one. */
export function decodeTokenAccountFields(
  owner: Address,
  data: Uint8Array,
): { program: "token" | "token-2022"; fields: Record<string, string | null> } | null {
  const kind = programKind(owner);
  if (!kind || !isAccountLayout(kind, data)) return null;
  const state = ACCOUNT_STATES[data[108] ?? -1];
  if (!state) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    program: kind,
    fields: {
      mint: addressDecoder.decode(data.subarray(0, 32)),
      owner: addressDecoder.decode(data.subarray(32, 64)),
      amount: view.getBigUint64(64, true).toString(),
      delegate: optionalAddress(data, 72),
      state,
      // COption<u64>: the rent-exempt reserve of a wrapped SOL account.
      isNative: data[109] === 1 ? view.getBigUint64(113, true).toString() : null,
      delegatedAmount: view.getBigUint64(121, true).toString(),
      closeAuthority: optionalAddress(data, 129),
    },
  };
}

/** Every base field of an SPL Token or Token-2022 mint (extensions are not decoded); null if not one. */
export function decodeMintFields(owner: Address, data: Uint8Array): Record<string, string | number | boolean | null> | null {
  const kind = programKind(owner);
  if (!kind || !isMintLayout(kind, data) || (data[45] !== 0 && data[45] !== 1)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mintAuthority: optionalAddress(data, 0),
    supply: view.getBigUint64(36, true).toString(),
    decimals: data[44] ?? 0,
    isInitialized: data[45] === 1,
    freezeAuthority: optionalAddress(data, 46),
  };
}
