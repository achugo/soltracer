import { STREAM_PAGE_SIZE, streamEventSchema } from "@soltracer/shared/stream";
import { getBase58Decoder } from "@solana/kit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.ts";
import { migrateUp } from "../../src/db/migrations.ts";
import { InvalidCursorError, PgStreamStore, type SeenTransaction } from "../../src/stream/stream-store.ts";
import { loadStreamFixture } from "../helpers/stream-fixtures.ts";
import { TEST_DATABASE_URL } from "../helpers/test-db.ts";

const { db, close } = createDb(TEST_DATABASE_URL);
const store = new PgStreamStore(db);
const fx = loadStreamFixture("jupiter-mentions");
const OTHER = "Vote111111111111111111111111111111111111111";
const RUN = "4b1f3a5e-9c2d-4e8f-a1b2-3c4d5e6f7a8b";

/** The recorded notifications, as the streamer will see them (integers as BigInt, as on the wire). */
const seen: SeenTransaction[] = fx.frames.flatMap((f) => {
  const frame = f as { method?: string; params?: { result: { context: { slot: bigint }; value: { signature: string; err: unknown; logs: string[] } } } };
  if (frame.method !== "logsNotification" || !frame.params) return [];
  const { context, value } = frame.params.result;
  return [{ wallet: fx.address, signature: value.signature, slot: Number(context.slot), onChainError: value.err, logs: value.logs }];
});
const failed = seen.find((s) => s.signature === fx.failed);
const succeeded = seen.find((s) => s.signature === fx.succeeded);

describe("PgStreamStore", () => {
  beforeAll(() => migrateUp(db));
  beforeEach(async () => {
    await db.execute(sql`truncate stream_events, runs`);
    // run_id references runs: the re-run the tests link must exist.
    await db.execute(sql`insert into runs (id, wallet, engine, input, overrides, result) values (${RUN}, ${OTHER}, 'local', 'AQID', '[]', '{}')`);
  });
  afterAll(close);

  it("stores each recorded notification once per wallet, as a pending event that fits the contract", async () => {
    for (const s of seen) {
      const event = await store.insertIfNew(s);
      expect(streamEventSchema.safeParse(event).success).toBe(true);
      expect(event).toMatchObject({ status: "pending", runId: null, deltas: null });
    }
    expect(await store.insertIfNew(seen[0] ?? seen[1] ?? never())).toBeNull(); // again: already stored
    if (!failed) throw new Error("fixture has no failure");
    expect(await store.insertIfNew({ ...failed, wallet: OTHER })).not.toBeNull(); // another wallet it mentions
    // Kit-style BigInt error indexes are stored as plain JSON numbers.
    const [first] = (await store.page(null)).events.filter((e) => e.signature === fx.failed);
    expect(JSON.stringify(first?.onChainError)).toMatch(/"InstructionError":\[\d+,/);
  });

  it("hydrates, then links a re-run to every wallet's row for a failed signature", async () => {
    if (!failed || !succeeded) throw new Error("fixture lacks a success or failure");
    await store.insertIfNew(failed);
    await store.insertIfNew({ ...failed, wallet: OTHER });
    await store.insertIfNew(succeeded);
    expect(await store.attachRun(failed.signature, RUN, true)).toEqual([]); // not hydrated yet: no re-run

    const deltas = { sol: { address: fx.address, pre: "10", post: "5", delta: "-5" }, tokens: [] };
    for (const wallet of [fx.address, OTHER]) {
      const h = await store.hydrated(wallet, failed.signature, { slot: failed.slot, blockTime: 1_792_060_318, onChainError: failed.onChainError, logs: failed.logs, deltas });
      expect(h).toMatchObject({ status: "hydrated", blockTime: 1_792_060_318, deltas });
    }
    await store.hydrated(fx.address, succeeded.signature, { slot: succeeded.slot, blockTime: null, onChainError: null, logs: succeeded.logs, deltas: null });

    const linked = await store.attachRun(failed.signature, RUN, false);
    expect(linked.map((e) => e.wallet).sort()).toEqual([fx.address, OTHER].sort());
    expect(linked.every((e) => e.runId === RUN && e.replayOutcomeMatches === false)).toBe(true);
    expect(await store.attachRun(succeeded.signature, RUN, true)).toEqual([]); // successes aren't re-run
  });

  it("marks hydration failures only on pending rows", async () => {
    if (!failed) throw new Error("fixture has no failure");
    await store.insertIfNew(failed);
    expect(await store.hydrateFailed(fx.address, failed.signature)).toMatchObject({ status: "hydrate_failed" });
    await store.hydrated(fx.address, failed.signature, { slot: failed.slot, blockTime: null, onChainError: failed.onChainError, logs: [], deltas: null });
    expect(await store.hydrateFailed(fx.address, failed.signature)).toBeNull();
  });

  it("pages newest first by slot with an opaque cursor, and rejects a forged one", async () => {
    const many: SeenTransaction[] = Array.from({ length: STREAM_PAGE_SIZE + 7 }, (_, i) => ({
      ...(succeeded ?? never()),
      signature: getBase58Decoder().decode(new Uint8Array(64).fill(i + 1)),
      slot: 1000 + i,
    }));
    for (const s of many) await store.insertIfNew(s);
    const first = await store.page(null);
    expect(first.events).toHaveLength(STREAM_PAGE_SIZE);
    expect(first.events.map((e) => e.slot)).toEqual([...first.events.map((e) => e.slot)].sort((a, b) => b - a));
    const second = await store.page(first.cursor);
    expect(second.events).toHaveLength(7);
    expect(second.cursor).toBeNull();
    expect(new Set([...first.events, ...second.events].map((e) => e.signature)).size).toBe(many.length);
    await expect(store.page("1; drop table runs")).rejects.toThrow(InvalidCursorError);
  });

  it("an unreadable row at the page boundary is skipped without ending paging", async () => {
    const many: SeenTransaction[] = Array.from({ length: STREAM_PAGE_SIZE + 3 }, (_, i) => ({
      ...(succeeded ?? never()),
      signature: getBase58Decoder().decode(new Uint8Array(64).fill(i + 1)),
      slot: 1000 + i,
    }));
    for (const s of many) await store.insertIfNew(s);
    // The 50th newest row (slot 1003) gets a status the contract doesn't know.
    await db.execute(sql`update stream_events set status = 'bogus' where slot = 1003`);
    const first = await store.page(null);
    expect(first.events).toHaveLength(STREAM_PAGE_SIZE - 1);
    expect(first.cursor).not.toBeNull();
    expect((await store.page(first.cursor)).events.map((e) => e.slot)).toEqual([1002, 1001, 1000]);
  });

  it("a wallet's row hydrated after the re-run was linked shares it", async () => {
    if (!failed) throw new Error("fixture has no failure");
    const hydration = { slot: failed.slot, blockTime: null, onChainError: failed.onChainError, logs: failed.logs, deltas: null };
    await store.insertIfNew(failed);
    await store.insertIfNew({ ...failed, wallet: OTHER });
    await store.hydrated(fx.address, failed.signature, hydration);
    await store.attachRun(failed.signature, RUN, true);
    expect(await store.hydrated(OTHER, failed.signature, hydration)).toMatchObject({ runId: RUN, replayOutcomeMatches: true });
  });

  it("knows each wallet's newest transaction and what still needs hydration", async () => {
    for (const s of seen) await store.insertIfNew(s);
    const newest = [...seen].sort((a, b) => b.slot - a.slot || (a.signature < b.signature ? 1 : -1))[0];
    expect(await store.latest(fx.address)).toEqual({ signature: newest?.signature, slot: newest?.slot });
    expect(await store.latest(OTHER)).toBeNull();
    expect(await store.pending(5)).toHaveLength(5);
  });

  it("stores log text Postgres would reject, cleaned", async () => {
    if (!succeeded) throw new Error("fixture has no success");
    const event = await store.insertIfNew({ ...succeeded, logs: ["Program log: a\u0000b"] });
    expect(event?.logs).toEqual(["Program log: a�b"]);
  });
});

function never(): never {
  throw new Error("fixture is missing a value");
}
