import { streamEventSchema, type StreamEvent } from "@soltracer/shared/stream";
import type { RpcTransport } from "@solana/kit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.ts";
import { migrateUp } from "../../src/db/migrations.ts";
import { createRpcClient } from "../../src/rpc/client.ts";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";
import { createReplayTransport } from "../../src/rpc/replay.ts";
import { createHydrator, type HydratedFailure } from "../../src/stream/hydrator.ts";
import { PgStreamStore } from "../../src/stream/stream-store.ts";
import { loadStreamFixture } from "../helpers/stream-fixtures.ts";
import { TEST_DATABASE_URL } from "../helpers/test-db.ts";

const { db, close } = createDb(TEST_DATABASE_URL);
const store = new PgStreamStore(db);
const fx = loadStreamFixture("jupiter-mentions");
const OTHER = "Vote111111111111111111111111111111111111111";
const txRecords = fx.rpc.filter((r) => r.method === "getTransaction");

function client(transport: RpcTransport) {
  return createRpcClient({
    url: "https://replay.invalid",
    limiter: createRateLimiter({ limit: 1000, windowMs: 1000 }),
    transport,
    log: { info: () => undefined, warn: () => undefined },
  });
}

/** Seeds pending rows the way notifications do (slot and signature only). */
async function seed(wallet: string, signature: string) {
  await store.insertIfNew({ wallet, signature, slot: 1, onChainError: null, logs: [] });
}

function setup(transport: RpcTransport, retryDelaysMs: number[] = [5, 5]) {
  const events: StreamEvent[] = [];
  const failures: HydratedFailure[] = [];
  const logs: Record<string, unknown>[] = [];
  const rpc = client(transport);
  const hydrator = createHydrator({
    store,
    session: () => rpc.session(),
    onEvent: (e) => events.push(e),
    onFailure: (f) => failures.push(f),
    log: { info: (obj) => logs.push(obj) },
    retryDelaysMs,
  });
  return { hydrator, events, failures, logs };
}

describe("createHydrator", () => {
  beforeAll(() => migrateUp(db));
  beforeEach(() => db.execute(sql`truncate stream_events, runs`));
  afterAll(close);

  it("hydrates the recorded success and failure, and hands the failure on for a re-run", async () => {
    await seed(fx.address, fx.succeeded);
    await seed(fx.address, fx.failed);
    const { hydrator, events, failures, logs } = setup(createReplayTransport(txRecords));
    hydrator.enqueue(fx.address, fx.succeeded);
    hydrator.enqueue(fx.address, fx.failed);
    await hydrator.idle();

    expect(events.map((e) => [e.signature, e.status])).toEqual([
      [fx.succeeded, "hydrated"],
      [fx.failed, "hydrated"],
    ]);
    for (const e of events) {
      expect(streamEventSchema.safeParse(e).success).toBe(true);
      expect(e.slot).toBeGreaterThan(400_000_000); // the real slot replaces the seed's
      expect(e.blockTime).toBeGreaterThan(1_700_000_000);
      expect(e.logs.length).toBeGreaterThan(0);
    }
    const failedEvent = events.find((e) => e.signature === fx.failed);
    expect(JSON.stringify(failedEvent?.onChainError)).toMatch(/^\{"InstructionError":\[\d+,\{"Custom":\d+\}\]\}$/);

    const recorded = (txRecords[1]?.response as { result: { transaction: [string] } }).result.transaction[0];
    expect(failures).toEqual([{ signature: fx.failed, slot: failedEvent?.slot, wire: recorded, onChainError: failedEvent?.onChainError, wallets: [fx.address] }]);
    expect(logs.filter((l) => l.credits === 10)).toHaveLength(2); // credits logged per transaction
  });

  it("fetches a transaction once for every wallet it mentions", async () => {
    await seed(fx.address, fx.failed);
    await seed(OTHER, fx.failed);
    const { hydrator, events, failures } = setup(createReplayTransport(txRecords));
    hydrator.enqueue(fx.address, fx.failed);
    hydrator.enqueue(OTHER, fx.failed); // the replay has one answer: a second fetch would fail
    await hydrator.idle();
    expect(events.map((e) => e.wallet).sort()).toEqual([fx.address, OTHER].sort());
    expect(failures).toHaveLength(1);
    expect(failures[0]?.wallets).toEqual([fx.address, OTHER]);
  });

  it("retries a transaction getTransaction can't see yet, then hydrates it", async () => {
    await seed(fx.address, fx.succeeded);
    const replay = createReplayTransport(txRecords);
    let calls = 0;
    const lagging = (async (config: Parameters<RpcTransport>[0]) => {
      calls += 1;
      if (calls === 1) return { jsonrpc: "2.0", id: (config.payload as { id?: unknown }).id, result: null }; // confirmed, not yet served
      return replay(config);
    }) as RpcTransport;
    const { hydrator, events } = setup(lagging);
    hydrator.enqueue(fx.address, fx.succeeded);
    await hydrator.idle();
    expect(calls).toBe(2);
    expect(events.map((e) => e.status)).toEqual(["hydrated"]);
  });

  it("gives up after its retries and marks the transaction, without logging RPC error text", async () => {
    await seed(fx.address, fx.succeeded);
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED https://mainnet.helius-rpc.com/?api-key=secret");
    }) as RpcTransport;
    const { hydrator, events, logs } = setup(failing, [5, 5]);
    hydrator.enqueue(fx.address, fx.succeeded);
    await hydrator.idle();
    expect(events.map((e) => e.status)).toEqual(["hydrate_failed"]);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("a wallet arriving while its transaction waits for a retry joins it (one fetch, one hand-off)", async () => {
    await seed(fx.address, fx.failed);
    await seed(OTHER, fx.failed);
    const replay = createReplayTransport(txRecords);
    let calls = 0;
    const lagging = (async (config: Parameters<RpcTransport>[0]) => {
      calls += 1;
      if (calls === 1) return { jsonrpc: "2.0", id: (config.payload as { id?: unknown }).id, result: null };
      return replay(config);
    }) as RpcTransport;
    const { hydrator, events, failures } = setup(lagging, [30]);
    hydrator.enqueue(fx.address, fx.failed);
    await new Promise((r) => setTimeout(r, 10)); // the first attempt found nothing; a retry is scheduled
    hydrator.enqueue(OTHER, fx.failed);
    await hydrator.idle();
    expect(calls).toBe(2);
    expect(events.map((e) => e.wallet).sort()).toEqual([fx.address, OTHER].sort());
    expect(failures).toHaveLength(1);
  });

  it("a wallet whose notification comes after hydration reuses the fetch, without a second hand-off", async () => {
    await seed(fx.address, fx.failed);
    await seed(OTHER, fx.failed);
    const { hydrator, events, failures } = setup(createReplayTransport(txRecords));
    hydrator.enqueue(fx.address, fx.failed);
    await hydrator.idle();
    hydrator.enqueue(OTHER, fx.failed); // the replay has no second answer: this must not fetch
    await hydrator.idle();
    expect(events.map((e) => [e.wallet, e.status])).toEqual([
      [fx.address, "hydrated"],
      [OTHER, "hydrated"],
    ]);
    expect(failures).toHaveLength(1);
  });

  it("a wallet joining while the transaction is being given up is marked too", async () => {
    await seed(fx.address, fx.succeeded);
    await seed(OTHER, fx.succeeded);
    const failing = (async () => {
      throw new Error("down");
    }) as RpcTransport;
    const events: StreamEvent[] = [];
    let hydrator: ReturnType<typeof createHydrator> | null = null;
    let joined = false;
    const slowStore = Object.create(store) as PgStreamStore;
    slowStore.hydrateFailed = async (wallet, signature) => {
      if (!joined) {
        joined = true;
        hydrator?.enqueue(OTHER, fx.succeeded); // arrives mid give-up
      }
      return store.hydrateFailed(wallet, signature);
    };
    const rpc = client(failing);
    hydrator = createHydrator({ store: slowStore, session: () => rpc.session(), onEvent: (e) => events.push(e), retryDelaysMs: [] });
    hydrator.enqueue(fx.address, fx.succeeded);
    await hydrator.idle();
    expect(events.map((e) => [e.wallet, e.status]).sort()).toEqual([
      [OTHER, "hydrate_failed"],
      [fx.address, "hydrate_failed"],
    ].sort());
  });

  it("a store failure doesn't escape or stop the queue: that row stays pending, the next is hydrated", async () => {
    await seed(fx.address, fx.succeeded);
    await seed(fx.address, fx.failed);
    const events: StreamEvent[] = [];
    const logs: Record<string, unknown>[] = [];
    const flaky = Object.create(store) as PgStreamStore;
    flaky.hydrated = async (wallet, signature, h) => {
      if (signature === fx.succeeded) throw new Error("connection terminated");
      return store.hydrated(wallet, signature, h);
    };
    const rpc = client(createReplayTransport(txRecords));
    const hydrator = createHydrator({ store: flaky, session: () => rpc.session(), onEvent: (e) => events.push(e), log: { info: (o) => logs.push(o) } });
    hydrator.enqueue(fx.address, fx.succeeded);
    hydrator.enqueue(fx.address, fx.failed);
    await hydrator.idle();
    expect(events.map((e) => e.signature)).toEqual([fx.failed]);
    expect(await store.pending(10)).toEqual([{ wallet: fx.address, signature: fx.succeeded }]);
    expect(logs).toContainEqual({ signature: fx.succeeded, why: "hydrate threw" });
  });

  it("callbacks that throw don't stop hydration", async () => {
    await seed(fx.address, fx.failed);
    const rpc = client(createReplayTransport(txRecords));
    const hydrator = createHydrator({
      store,
      session: () => rpc.session(),
      onEvent: () => {
        throw new Error("ui gone");
      },
      onFailure: () => {
        throw new Error("runner gone");
      },
    });
    hydrator.enqueue(fx.address, fx.failed);
    await hydrator.idle();
    expect((await store.page(null)).events[0]?.status).toBe("hydrated");
  });

  it("nothing is written after stop(), even by a fetch already in flight", async () => {
    await seed(fx.address, fx.succeeded);
    const replay = createReplayTransport(txRecords);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (config: Parameters<RpcTransport>[0]) => {
      await gate;
      return replay(config);
    }) as RpcTransport;
    const { hydrator, events } = setup(slow);
    hydrator.enqueue(fx.address, fx.succeeded);
    await new Promise((r) => setTimeout(r, 10));
    hydrator.stop();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
    expect((await store.page(null)).events[0]?.status).toBe("pending");
  });

  it("stop() drops queued and scheduled work", async () => {
    await seed(fx.address, fx.succeeded);
    const never = (async () => ({ jsonrpc: "2.0", id: 1, result: null })) as RpcTransport;
    const { hydrator } = setup(never, [10_000]);
    hydrator.enqueue(fx.address, fx.succeeded);
    await new Promise((r) => setTimeout(r, 20));
    hydrator.stop();
    await hydrator.idle(); // resolves: no pending retry timer keeps it busy
    hydrator.enqueue(fx.address, fx.succeeded); // ignored after stop
    await hydrator.idle();
  });
});

