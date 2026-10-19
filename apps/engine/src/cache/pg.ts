import type { Address } from "@solana/kit";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { normalizedIdlSchema } from "../decode/idl-full.ts";
import { cleanJson } from "../text/clean.ts";
import { idlCache, lookupTableCache, mintCache } from "../db/schema.ts";
import { isIdlFresh, type SandboxCaches } from "./types.ts";

const storedIdlErrors = z.array(z.tuple([z.number().int(), z.string(), z.string()]));

export function createPgCaches(db: Db): SandboxCaches {
  return {
    mints: {
      async getMany(keys) {
        if (keys.length === 0) return new Map();
        const rows = await db.select().from(mintCache).where(inArray(mintCache.mint, [...keys]));
        return new Map(rows.map((r) => [r.mint as Address, { decimals: r.decimals, program: r.program }]));
      },
      async putMany(entries) {
        if (entries.size === 0) return;
        await db
          .insert(mintCache)
          .values([...entries].map(([mint, info]) => ({ mint, decimals: info.decimals, program: info.program })))
          .onConflictDoNothing();
      },
    },
    lookupTables: {
      async getMany(keys) {
        if (keys.length === 0) return new Map();
        const rows = await db.select().from(lookupTableCache).where(inArray(lookupTableCache.address, [...keys]));
        return new Map(rows.map((r) => [r.address as Address, r.addresses as Address[]]));
      },
      async putMany(entries) {
        for (const e of entries) {
          await db
            .insert(lookupTableCache)
            .values({ address: e.address, addresses: [...e.addresses], slot: e.slot, fetchedAt: new Date() })
            .onConflictDoUpdate({
              target: lookupTableCache.address,
              set: { addresses: [...e.addresses], slot: e.slot, fetchedAt: new Date() },
              // Tables only grow; never replace a longer cached copy with a shorter one.
              setWhere: sql`cardinality(${lookupTableCache.addresses}) < ${e.addresses.length}`,
            });
        }
      },
    },
    idls: {
      async get(program) {
        const [row] = await db.select().from(idlCache).where(eq(idlCache.program, program));
        if (!row || !isIdlFresh(row.found, row.fetchedAt)) return undefined;
        if (!row.found) return { found: false };
        // jsonb is only typed at compile time; treat a malformed row as a cache miss.
        const errors = storedIdlErrors.safeParse(row.errors ?? []);
        const idl = row.idl === null ? null : normalizedIdlSchema.safeParse(row.idl);
        if (!errors.success || idl?.success === false) return undefined;
        return {
          found: true,
          errors: new Map(errors.data.map(([code, name, message]) => [code, { name, message }])),
          idl: idl?.data ?? null,
        };
      },
      async put(program, entry) {
        const errors = entry.found
          ? [...entry.errors].map(([code, e]): [number, string, string] => [code, e.name, e.message])
          : null;
        // An IDL's type expressions are the author's JSON; strings jsonb rejects are replaced.
        const idl = entry.found && entry.idl ? cleanJson(entry.idl) : null;
        const values = { program, found: entry.found, errors, idl, fetchedAt: new Date() };
        await db
          .insert(idlCache)
          .values(values)
          .onConflictDoUpdate({ target: idlCache.program, set: { found: values.found, errors, idl, fetchedAt: values.fetchedAt } });
      },
    },
  };
}
