import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgNonceStore } from "../src/auth/nonce-store.ts";
import { createDb } from "../src/db/client.ts";
import { migrateUp } from "../src/db/migrations.ts";
import { TEST_DATABASE_URL } from "./helpers/test-db.ts";

const { db, close } = createDb(TEST_DATABASE_URL);
const store = new PgNonceStore(db);
const t0 = new Date("2026-10-13T12:00:00.000Z");
const t5 = new Date(t0.getTime() + 5 * 60 * 1000);

describe("PgNonceStore", () => {
  beforeAll(() => migrateUp(db));
  beforeEach(() => db.execute(sql`truncate auth_nonces`));
  afterAll(close);

  it("consumes a fresh nonce once and returns its issued time", async () => {
    await store.create("nonceA", t0, t5);
    expect(await store.consume("nonceA", t0)).toEqual({ status: "ok", issuedAt: t0 });
    expect(await store.consume("nonceA", t0)).toEqual({ status: "used" });
  });

  it("reports unknown and expired nonces", async () => {
    expect(await store.consume("missing", t0)).toEqual({ status: "unknown" });
    await store.create("nonceB", t0, t5);
    expect(await store.consume("nonceB", t5)).toEqual({ status: "expired" });
  });

  it("lets only one of many concurrent consumers win", async () => {
    await store.create("nonceC", t0, t5);
    const results = await Promise.all(Array.from({ length: 10 }, () => store.consume("nonceC", t0)));
    expect(results.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.status === "used")).toHaveLength(9);
  });

  it("prunes nonces that expired before the cutoff", async () => {
    await store.create("old", t0, t5);
    await store.create("fresh", t5, new Date(t5.getTime() + 2));
    expect(await store.pruneExpired(new Date(t5.getTime() + 1))).toBe(1);
    expect(await store.consume("fresh", t5)).toEqual({ status: "ok", issuedAt: t5 });
  });
});
