import bs58 from "bs58";
import { z } from "zod";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Decoded byte length of a base58 string, or null when it is not base58. */
export function base58ByteLength(value: string): number | null {
  if (!BASE58.test(value)) return null;
  try {
    return bs58.decode(value).length;
  } catch {
    return null;
  }
}

const base58Bytes = (bytes: number, label: string) =>
  z
    .string()
    .max(128)
    .refine((v) => base58ByteLength(v) === bytes, `Must be a base58 ${label} (${bytes} bytes)`);

export const pubkeySchema = base58Bytes(32, "public key");
export const signatureSchema = base58Bytes(64, "signature");

export type Pubkey = z.infer<typeof pubkeySchema>;
