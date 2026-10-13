import { z } from "zod";
import { createDb } from "../src/db/client.ts";
import { migrateDown, migrateUp } from "../src/db/migrations.ts";

const direction = z.enum(["up", "down"]).parse(process.argv[2] ?? "up");
const { DATABASE_URL } = z.object({ DATABASE_URL: z.url() }).parse(process.env);

const { db, close } = createDb(DATABASE_URL);
try {
  if (direction === "up") {
    await migrateUp(db);
    console.warn("migrations applied");
  } else {
    const tag = await migrateDown(db);
    console.warn(tag ? `rolled back ${tag}` : "nothing to roll back");
  }
} finally {
  await close();
}
