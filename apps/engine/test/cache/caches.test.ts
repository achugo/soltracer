import { address } from "@solana/kit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import { createPgCaches } from "../../src/cache/pg.ts";
import { IDL_ABSENT_TTL_MS, IDL_FOUND_TTL_MS, type SandboxCaches } from "../../src/cache/types.ts";
import { createDb } from "../../src/db/client.ts";
import { migrateUp } from "../../src/db/migrations.ts";
import { TEST_DATABASE_URL } from "../helpers/test-db.ts";

const A = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const B = address("So11111111111111111111111111111111111111112");
const T = address("SysvarRent111111111111111111111111111111111");

const { db, close } = createDb(TEST_DATABASE_URL);

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

    it("stores IDL error tables and the absence of an IDL", async () => {
      const caches = make();
      await caches.idls.put(A, { found: true, errors: new Map([[6001, { name: "Slip", message: "Slipped" }]]) });
      await caches.idls.put(B, { found: false });
      expect(await caches.idls.get(A)).toEqual({ found: true, errors: new Map([[6001, { name: "Slip", message: "Slipped" }]]) });
      expect(await caches.idls.get(B)).toEqual({ found: false });
      expect(await caches.idls.get(T)).toBeUndefined();
    });

    it("expires a missing IDL after a week and a found one after 30 days", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const caches = make();
        vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
        await caches.idls.put(A, { found: true, errors: new Map() });
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
