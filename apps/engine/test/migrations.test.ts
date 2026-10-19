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

const TABLES = ["auth_nonces", "mint_cache", "lookup_table_cache", "idl_cache"];

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

    expect(await migrateDown(db)).toBe("0001_sandbox_caches");
    expect(await tableExists("mint_cache")).toBe(false);
    expect(await tableExists("auth_nonces")).toBe(true);

    expect(await migrateDown(db)).toBe("0000_auth_nonces");
    expect(await tableExists("auth_nonces")).toBe(false);
    expect(await migrateDown(db)).toBeNull();

    await migrateUp(db);
    for (const t of TABLES) expect(await tableExists(t)).toBe(true);
  });
});
