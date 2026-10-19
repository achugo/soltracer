import { address } from "@solana/kit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import { createPgCaches } from "../../src/cache/pg.ts";
import { normalizeIdl } from "../../src/decode/idl-full.ts";
import { IDL_ABSENT_TTL_MS, IDL_FOUND_TTL_MS, type SandboxCaches } from "../../src/cache/types.ts";
import { createDb } from "../../src/db/client.ts";
import { migrateUp } from "../../src/db/migrations.ts";
import { TEST_DATABASE_URL } from "../helpers/test-db.ts";

const A = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const B = address("So11111111111111111111111111111111111111112");
const T = address("SysvarRent111111111111111111111111111111111");

const { db, close } = createDb(TEST_DATABASE_URL);

const IDL = normalizeIdl({
  instructions: [{ name: "swap", discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: "pool" }], args: [{ name: "amount", type: "u64" }] }],
  accounts: [{ name: "Pool", discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }],
  types: [{ name: "Pool", type: { kind: "struct", fields: [{ name: "fee", type: "u16" }] } }],
});

function sharedBehaviour(name: string, make: () => SandboxCaches) {
  describe(name, () => {
    it("stores and returns mint decimals, omitting unknown mints", async () => {
      const caches = make();
      await caches.mints.putMany(new Map([[A, { decimals: 6, program: "token" as const }]]));
      expect(await caches.mints.getMany([A, B])).toEqual(new Map([[A, { decimals: 6, program: "token" }]]));
    });

    it("stores lookup tables and keeps the longer copy (tables only grow)", async () => {
      const caches = make();
      await caches.lookupTables.putMany([{ address: T, addresses: [A, B], slot: 10n }]);
      await caches.lookupTables.putMany([{ address: T, addresses: [A], slot: 5n }]);
      expect(await caches.lookupTables.getMany([T, A])).toEqual(new Map([[T, [A, B]]]));
    });

    it("replaces a cached lookup table when the new copy is longer", async () => {
      const caches = make();
      await caches.lookupTables.putMany([{ address: T, addresses: [A], slot: 5n }]);
      await caches.lookupTables.putMany([{ address: T, addresses: [A, B], slot: 10n }]);
      expect(await caches.lookupTables.getMany([T])).toEqual(new Map([[T, [A, B]]]));
    });

    it("stores IDL error tables, the decoding IDL and the absence of an IDL", async () => {
      const caches = make();
      const errors = new Map([[6001, { name: "Slip", message: "Slipped" }]]);
      await caches.idls.put(A, { found: true, errors, idl: IDL });
      await caches.idls.put(B, { found: false });
      await caches.idls.put(T, { found: true, errors, idl: null });
      expect(await caches.idls.get(A)).toEqual({ found: true, errors, idl: IDL });
      expect(await caches.idls.get(B)).toEqual({ found: false });
      expect(await caches.idls.get(T)).toEqual({ found: true, errors, idl: null });
      expect(await caches.idls.get(address("11111111111111111111111111111111"))).toBeUndefined();
    });

    it("expires a missing IDL after a week and a found one after 30 days", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const caches = make();
        vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
        await caches.idls.put(A, { found: true, errors: new Map(), idl: null });
        await caches.idls.put(B, { found: false });
        vi.setSystemTime(new Date(Date.parse("2026-10-01T00:00:00Z") + IDL_ABSENT_TTL_MS + 1));
        expect(await caches.idls.get(B)).toBeUndefined();
        expect(await caches.idls.get(A)).toBeDefined();
        vi.setSystemTime(new Date(Date.parse("2026-10-01T00:00:00Z") + IDL_FOUND_TTL_MS + 1));
        expect(await caches.idls.get(A)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
}

beforeAll(() => migrateUp(db));
beforeEach(() => db.execute(sql`truncate mint_cache, lookup_table_cache, idl_cache`));
afterAll(close);

sharedBehaviour("memory caches", createMemoryCaches);
sharedBehaviour("postgres caches", () => createPgCaches(db));

describe("postgres IDL cache", () => {
  it("treats a stored IDL that no longer validates as a miss", async () => {
    const caches = createPgCaches(db);
    await caches.idls.put(A, { found: true, errors: new Map(), idl: IDL });
    await db.execute(sql`update idl_cache set idl = '{"instructions": 5}'::jsonb`);
    expect(await caches.idls.get(A)).toBeUndefined();
  });
});
