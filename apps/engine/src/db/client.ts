import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 5, onnotice: () => undefined });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>["db"];
