import type { Address } from "@solana/kit";
import type { NormalizedIdl } from "../decode/idl-full.ts";
import type { IdlErrorInfo } from "../decode/idl.ts";

export interface MintInfo {
  decimals: number;
  program: "token" | "token-2022";
}

/** A found IDL's `idl` is null when it is too large to keep or not in a format we decode. */
export type IdlCacheEntry =
  | { found: false }
  | { found: true; errors: Map<number, IdlErrorInfo>; idl: NormalizedIdl | null };

/** Immutable-ish chain data the sandbox reuses across runs to save RPC credits. */
export interface SandboxCaches {
  mints: {
    getMany(mints: readonly Address[]): Promise<Map<Address, MintInfo>>;
    putMany(entries: ReadonlyMap<Address, MintInfo>): Promise<void>;
  };
  lookupTables: {
    getMany(tables: readonly Address[]): Promise<Map<Address, Address[]>>;
    /** Keeps the longer copy: tables only ever grow. */
    putMany(entries: readonly { address: Address; addresses: readonly Address[]; slot: bigint | null }[]): Promise<void>;
  };
  idls: {
    /** Undefined when never fetched or stale. */
    get(program: Address): Promise<IdlCacheEntry | undefined>;
    put(program: Address, entry: IdlCacheEntry): Promise<void>;
  };
}

/** A missing IDL may be published later; a found one may be upgraded. */
export const IDL_ABSENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IDL_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isIdlFresh(found: boolean, fetchedAt: Date, now = Date.now()): boolean {
  return now - fetchedAt.getTime() <= (found ? IDL_FOUND_TTL_MS : IDL_ABSENT_TTL_MS);
}
