import { PgNonceStore } from "./auth/nonce-store.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { buildServer, ENGINE_HOST } from "./server.ts";

const PRUNE_EVERY_MS = 10 * 60 * 1000;

function configOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const config = configOrExit();
const { db, close } = createDb(config.DATABASE_URL);
const nonceStore = new PgNonceStore(db);
const app = buildServer({
  config,
  nonceStore,
  logger: { level: "info", redact: ["req.headers.authorization"] },
});

const prune = setInterval(() => {
  nonceStore.pruneExpired(new Date()).catch((err: unknown) => app.log.warn({ err }, "nonce prune failed"));
}, PRUNE_EVERY_MS);

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  clearInterval(prune);
  try {
    await app.close();
    await close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "shutdown failed");
    process.exit(1);
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: ENGINE_HOST, port: config.ENGINE_PORT });
} catch (err) {
  app.log.error({ err }, "engine failed to start");
  clearInterval(prune);
  await close();
  process.exit(1);
}
