import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { z } from "zod";
import type { Db } from "./client.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

const journalSchema = z.object({
  entries: z.array(z.object({ when: z.number(), tag: z.string().regex(/^[\w-]+$/) })),
});

export async function migrateUp(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

/**
 * Rolls back the most recently applied migration by running drizzle/down/<tag>.sql
 * and removing its row from drizzle's journal table. Returns the tag, or null if none applied.
 */
export async function migrateDown(db: Db): Promise<string | null> {
  const { entries } = journalSchema.parse(
    JSON.parse(await readFile(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8")),
  );
  const rows = await db.execute<{ created_at: string }>(
    sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
  );
  const latest = rows[0];
  if (!latest) return null;
  const entry = entries.find((e) => e.when === Number(latest.created_at));
  if (!entry) throw new Error(`No journal entry for applied migration ${latest.created_at}`);
  const down = await readFile(`${MIGRATIONS_DIR}/down/${entry.tag}.sql`, "utf8");
  await db.transaction(async (tx) => {
    for (const statement of down.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.execute(sql.raw(statement));
    }
    await tx.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${latest.created_at}`);
  });
  return entry.tag;
}
