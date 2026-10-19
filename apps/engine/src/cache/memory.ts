import type { Address } from "@solana/kit";
import { isIdlFresh, type IdlCacheEntry, type MintInfo, type SandboxCaches } from "./types.ts";

/** In-process caches: for tests and the fixture recorder (always cold). */
export function createMemoryCaches(): SandboxCaches {
  const mints = new Map<Address, MintInfo>();
  const tables = new Map<Address, Address[]>();
  const idls = new Map<Address, { entry: IdlCacheEntry; at: Date }>();
  return {
    mints: {
      getMany: async (keys) => new Map(keys.flatMap((k) => (mints.has(k) ? [[k, mints.get(k) as MintInfo]] : []))),
      putMany: async (entries) => {
        for (const [k, v] of entries) mints.set(k, v);
      },
    },
    lookupTables: {
      getMany: async (keys) => new Map(keys.flatMap((k) => (tables.has(k) ? [[k, tables.get(k) as Address[]]] : []))),
      putMany: async (entries) => {
        for (const { address, addresses } of entries) {
          if ((tables.get(address)?.length ?? -1) < addresses.length) tables.set(address, [...addresses]);
        }
      },
    },
    idls: {
      get: async (program) => {
        const hit = idls.get(program);
        return hit && isIdlFresh(hit.entry.found, hit.at) ? hit.entry : undefined;
      },
      put: async (program, entry) => {
        idls.set(program, { entry, at: new Date() });
      },
    },
  };
}
