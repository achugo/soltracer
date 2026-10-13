import { makeError, type ErrorResponse } from "@soltracer/shared/errors";
import { MAX_V1_TX_BYTES, maxTxBytes, type TxVersion } from "@soltracer/shared/simulation";
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type CompiledTransactionMessage,
  type CompiledTransactionMessageWithLifetime,
} from "@solana/kit";
import bs58 from "bs58";

export type CompiledMessage = CompiledTransactionMessage & CompiledTransactionMessageWithLifetime;

function hasLifetime(m: CompiledTransactionMessage): m is CompiledMessage {
  return "lifetimeToken" in m && typeof m.lifetimeToken === "string";
}
export type Encoding = "base64" | "base58";

export interface Lookup {
  table: Address;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface DecodedTransaction {
  encoding: Encoding;
  version: TxVersion;
  /** Serialized size in bytes. */
  size: number;
  numSignatures: number;
  /** True when any signature slot is non-zero. */
  signed: boolean;
  /** Canonical base64 wire form, for simulateTransaction. */
  wireBase64: string;
  header: {
    numSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  };
  staticAccounts: Address[];
  lookups: Lookup[];
  compiled: CompiledMessage;
}

export type DecodeResult = { ok: true; tx: DecodedTransaction } | { ok: false; error: ErrorResponse };

interface Attempt {
  encoding: Encoding;
  reason: string;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function fromBase64(text: string): Uint8Array | string {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return "not valid base64 (characters or length)";
  return new Uint8Array(Buffer.from(text, "base64"));
}

function fromBase58(text: string): Uint8Array | string {
  if (!BASE58.test(text)) return "not valid base58 (contains characters outside the base58 alphabet)";
  try {
    return bs58.decode(text);
  } catch {
    return "not valid base58";
  }
}

/** Parses wire bytes; throws with a short reason when they are not exactly one transaction. */
function parseWire(bytes: Uint8Array, encoding: Encoding): DecodedTransaction {
  const [tx, end] = getTransactionDecoder().read(bytes, 0);
  if (end !== bytes.length) throw new Error(`${bytes.length - end} unexpected trailing bytes`);
  const [compiled, messageEnd] = getCompiledTransactionMessageDecoder().read(tx.messageBytes, 0);
  if (messageEnd !== tx.messageBytes.length) throw new Error("message has trailing bytes");
  if (!hasLifetime(compiled)) throw new Error("message has no recent blockhash or nonce");

  const signatures = Object.values(tx.signatures);
  const lookups =
    "addressTableLookups" in compiled && compiled.addressTableLookups
      ? compiled.addressTableLookups.map((l) => ({
          table: l.lookupTableAddress,
          writableIndexes: [...l.writableIndexes],
          readonlyIndexes: [...l.readonlyIndexes],
        }))
      : [];

  return {
    encoding,
    version: compiled.version,
    size: bytes.length,
    numSignatures: signatures.length,
    signed: signatures.some((s) => s !== null && s.some((b) => b !== 0)),
    wireBase64: Buffer.from(bytes).toString("base64"),
    header: { ...compiled.header },
    staticAccounts: [...compiled.staticAccounts],
    lookups,
    compiled,
  };
}

/**
 * Accepts a pasted transaction in base64 or base58 (whitespace ignored). Tries base64 first,
 * since wallets and APIs emit it, then base58. Errors say which encodings were tried and why.
 */
export function decodeTransactionInput(input: string): DecodeResult {
  const text = input.replace(/\s+/g, "");
  const tried: Attempt[] = [];
  let tooLarge: ErrorResponse | null = null;

  for (const [encoding, decode] of [
    ["base64", fromBase64],
    ["base58", fromBase58],
  ] as const) {
    const bytes = decode(text);
    if (typeof bytes === "string") {
      tried.push({ encoding, reason: bytes });
      continue;
    }
    // A base58 string can also pass as base64 (decoding to ~2% more bytes), so an oversized
    // attempt is not final: another encoding may still yield a valid transaction.
    if (bytes.length > MAX_V1_TX_BYTES) {
      tried.push({ encoding, reason: `${bytes.length} bytes, over the ${MAX_V1_TX_BYTES}-byte maximum` });
      tooLarge ??= makeError(
        "TX_TOO_LARGE",
        `Transaction is ${bytes.length} bytes; the largest allowed is ${MAX_V1_TX_BYTES}.`,
        { size: bytes.length, limit: MAX_V1_TX_BYTES, encoding },
      );
      continue;
    }
    let tx: DecodedTransaction;
    try {
      tx = parseWire(bytes, encoding);
    } catch (err) {
      tried.push({ encoding, reason: `not a valid transaction: ${err instanceof Error ? err.message : "decode failed"}` });
      continue;
    }
    const limit = maxTxBytes(tx.version);
    if (tx.size > limit) {
      tried.push({ encoding, reason: `${tx.size} bytes, over the version ${tx.version} limit of ${limit}` });
      tooLarge = makeError(
        "TX_TOO_LARGE",
        `Transaction is ${tx.size} bytes; version ${tx.version} transactions are limited to ${limit}.`,
        { size: tx.size, limit, version: tx.version, encoding },
      );
      continue;
    }
    return { ok: true, tx };
  }

  if (tooLarge) return { ok: false, error: tooLarge };
  return {
    ok: false,
    error: makeError("TX_DECODE_FAILED", "Could not read this as a base64 or base58 transaction.", { tried }),
  };
}
