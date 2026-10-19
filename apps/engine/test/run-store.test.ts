import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.ts";
import { migrateUp } from "../src/db/migrations.ts";
import type { SimulationResult } from "@soltracer/shared/simulation";
import { PgRunStore } from "../src/runs/run-store.ts";
import { TEST_DATABASE_URL } from "./helpers/test-db.ts";

const { db, close } = createDb(TEST_DATABASE_URL);
const store = new PgRunStore(db);
const RESULT = {
  ok: true,
  status: { success: true },
  fee: { baseLamports: "18446744073709551615" },
} as unknown as SimulationResult; // only round-tripping matters here
const WALLET = "SysvarRent111111111111111111111111111111111";
const OTHER = "SysvarC1ock11111111111111111111111111111111";

describe("PgRunStore", () => {
  beforeAll(() => migrateUp(db));
  beforeEach(() => db.execute(sql`truncate runs`));
  afterAll(close);

  it("stores a run under a fresh random v4 id and reads it back for the same wallet", async () => {
    const result = RESULT;
    const overrides = [{ kind: "sol" as const, address: WALLET, lamports: "1" }];
    const id = await store.create({ wallet: WALLET, engine: "local", input: "AQID", overrides, result });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await store.get(id, WALLET)).toMatchObject({ id, wallet: WALLET, engine: "local", input: "AQID", result });
  });

  it("never returns another wallet's run", async () => {
    const id = await store.create({ wallet: WALLET, engine: "rpc", input: "AQID", overrides: [], result: RESULT });
    expect(await store.get(id, OTHER)).toBeNull();
    expect(await store.get("00000000-0000-4000-8000-000000000000", WALLET)).toBeNull();
    expect(await store.get("not-a-uuid", WALLET)).toBeNull();
  });

  it("gives every run a different id", async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => store.create({ wallet: WALLET, engine: "rpc", input: "AQID", overrides: [], result: RESULT })),
    );
    expect(new Set(ids).size).toBe(20);
  });
});
