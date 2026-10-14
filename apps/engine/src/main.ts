import { PgNonceStore } from "./auth/nonce-store.ts";
import { createPgCaches } from "./cache/pg.ts";
import { createRpcClient } from "./rpc/client.ts";
import { createRateLimiter } from "./rpc/rate-limiter.ts";
import { optimizeWithRpc, signatureStatus } from "./optimize/optimizer.ts";
import { PgRunStore } from "./runs/run-store.ts";
import { createProgramCache } from "./sim/local/loader.ts";
import type { LocalRunInput, LocalRunOutput } from "./sim/local/runner.ts";
import { createWorkerPool, LOCAL_RUNNER_WORKER } from "./sim/local/worker-pool.ts";
import { MAX_CONCURRENT_LOCAL_RUNS, runSandbox } from "./sim/sandbox.ts";
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
const caches = createPgCaches(db);
const programCache = createProgramCache();
const runs = new PgRunStore(db);
// LiteSVM runs off the event loop; a run past 10 s is stopped and its worker replaced.
const localPool = createWorkerPool<LocalRunInput, LocalRunOutput>({
  size: MAX_CONCURRENT_LOCAL_RUNS,
  timeoutMs: 10_000,
  workerUrl: LOCAL_RUNNER_WORKER,
});

// The engine's only Helius client: 10 requests in any 1-second window, shared by every request.
const rpc = createRpcClient({
  url: config.HELIUS_RPC_URL,
  limiter: createRateLimiter({ limit: 10, windowMs: 1000, maxQueue: 50 }),
  log: {
    info: (obj, msg) => app.log.info(obj, msg),
    warn: (obj, msg) => app.log.warn(obj, msg),
  },
});

const app = buildServer({
  config,
  nonceStore,
  logger: { level: "info", redact: ["req.headers.authorization"] },
  simulate: (request, wallet, log, signal) =>
    runSandbox(request, wallet, {
      session: rpc.session({ signal }),
      caches,
      programCache,
      runs,
      log,
      localRunner: (input) => localPool.run(input),
      idlMode: "fetch",
    }),
  optimize: (input, log, signal) => optimizeWithRpc(input, rpc.session({ signal }), caches, log),
  txStatus: (signature, signal) => signatureStatus(rpc.session({ signal }), signature),
});

const prune = setInterval(() => {
  nonceStore.pruneExpired(new Date()).catch((err: unknown) => app.log.warn({ err }, "nonce prune failed"));
}, PRUNE_EVERY_MS);

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  clearInterval(prune);
  try {
    await app.close();
    await localPool.close();
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
