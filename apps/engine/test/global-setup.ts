import { ensureTestDatabase } from "./helpers/test-db.ts";

export default async function setup(): Promise<void> {
  await ensureTestDatabase();
}
