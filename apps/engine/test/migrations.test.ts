import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.ts";
import { migrateDown, migrateUp } from "../src/db/migrations.ts";
import { TEST_DATABASE_URL } from "./helpers/test-db.ts";

const { db, close } = createDb(TEST_DATABASE_URL);

async function tableExists(name: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(
    sql`select to_regclass(${`public.${name}`}) is not null as exists`,
  );
  return rows[0]?.exists === true;
}

// stream_events references runs, so it is dropped first.
const TABLES = ["auth_nonces", "mint_cache", "lookup_table_cache", "idl_cache", "stream_events", "runs"];

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(
    sql`select exists (select 1 from information_schema.columns where table_name = ${table} and column_name = ${column}) as exists`,
  );
  return rows[0]?.exists === true;
}

async function resetSchema(): Promise<void> {
  await db.execute(sql`drop schema if exists drizzle cascade`);
  for (const t of TABLES) await db.execute(sql.raw(`drop table if exists ${t}`));
}

describe("migrations", () => {
  beforeAll(resetSchema);
  afterAll(async () => {
    await migrateUp(db);
    await close();
  });

  it("run up, down and up again cleanly", async () => {
    await migrateUp(db);
    for (const t of TABLES) expect(await tableExists(t)).toBe(true);
    expect(await columnExists("idl_cache", "idl")).toBe(true);
    expect(await columnExists("runs", "source")).toBe(true);

    expect(await migrateDown(db)).toBe("0004_stream_events");
    expect(await tableExists("stream_events")).toBe(false);
    expect(await columnExists("runs", "source")).toBe(false);
    expect(await tableExists("runs")).toBe(true);

    expect(await migrateDown(db)).toBe("0003_idl_full");
    expect(await columnExists("idl_cache", "idl")).toBe(false);
    expect(await tableExists("idl_cache")).toBe(true);

    expect(await migrateDown(db)).toBe("0002_runs");
    expect(await tableExists("runs")).toBe(false);
    expect(await tableExists("mint_cache")).toBe(true);

    expect(await migrateDown(db)).toBe("0001_sandbox_caches");
    expect(await tableExists("mint_cache")).toBe(false);
    expect(await tableExists("auth_nonces")).toBe(true);

    expect(await migrateDown(db)).toBe("0000_auth_nonces");
    expect(await tableExists("auth_nonces")).toBe(false);
    expect(await migrateDown(db)).toBeNull();

    await migrateUp(db);
    for (const t of TABLES) expect(await tableExists(t)).toBe(true);
    expect(await columnExists("idl_cache", "idl")).toBe(true);
  });
});
