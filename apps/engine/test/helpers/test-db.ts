import postgres from "postgres";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://soltracer:soltracer@127.0.0.1:5432/soltracer_test";

/** Creates the test database if it does not exist. Requires `docker compose up -d`. */
export async function ensureTestDatabase(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`Refusing to use ${name} for tests: name must end in _test`);
  url.pathname = "/postgres";
  const admin = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`;
    if (rows.length === 0) await admin.unsafe(`create database "${name.replace(/"/g, "")}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
