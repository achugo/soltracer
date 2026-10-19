import { base58ByteLength } from "@soltracer/shared/solana";

export type DetectedEncoding = "base64" | "base58" | "unknown";

export interface TxInputHint {
  encoding: DetectedEncoding;
  /** Decoded length, or null when the input cannot be decoded. */
  bytes: number | null;
  /** Why the input was not recognised, for `unknown`. */
  reason: string | null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** Characters valid in base64 but not in base58. */
const BASE64_ONLY = /[0OIl+/=]/;

function base64ByteLength(text: string): number | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/**
 * Guesses the encoding of a pasted transaction, ignoring whitespace. Returns null for empty input.
 *
 * A UI hint only; the engine is authoritative. Every base58 character is also a base64 character,
 * so a string with none of `0 O I l + / =` is called base58: a real base64 transaction of a few
 * hundred characters almost never avoids all six.
 */
export function detectTxInput(input: string): TxInputHint | null {
  const text = input.replace(/\s+/g, "");
  if (text === "") return null;

  if (BASE64_ONLY.test(text)) {
    const bytes = base64ByteLength(text);
    if (bytes !== null) return { encoding: "base64", bytes, reason: null };
    return {
      encoding: "unknown",
      bytes: null,
      reason: BASE64.test(text)
        ? "looks like base64 but the length is not a multiple of 4"
        : "contains characters outside base64 and base58",
    };
  }
  if (BASE58.test(text)) {
    const bytes = base58ByteLength(text);
    if (bytes !== null) return { encoding: "base58", bytes, reason: null };
  }
  return { encoding: "unknown", bytes: null, reason: "contains characters outside base64 and base58" };
}
