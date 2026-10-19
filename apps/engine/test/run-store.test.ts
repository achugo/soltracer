import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.ts";
import { migrateUp } from "../src/db/migrations.ts";
import { runs } from "../src/db/schema.ts";
import { PgRunStore, UnreadableRunError } from "../src/runs/run-store.ts";
import { PAYER, simulationResult } from "./helpers/simulation-result.ts";
import { TEST_DATABASE_URL } from "./helpers/test-db.ts";

const { db, close } = createDb(TEST_DATABASE_URL);
const store = new PgRunStore(db);
const WALLET = PAYER;
const SIG = "5uZ4k7UX55vNUg7DZBvH67MByyvP8wRuJmaD8o3BgxsfyDimz1hMRgRPrS3rG9zVTk47XjJmrmNrn7MgXn7aym9y";

describe("PgRunStore", () => {
  beforeAll(() => migrateUp(db));
  beforeEach(() => db.execute(sql`truncate runs, stream_events`)); // stream_events references runs
  afterAll(close);

  it("stores a sandbox run under a fresh random v4 id and reads it back with its id", async () => {
    const overrides = [{ kind: "sol" as const, address: WALLET, lamports: "1" }];
    const id = await store.create({ wallet: WALLET, engine: "local", input: "AQID", overrides, result: simulationResult() });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const run = await store.get(id);
    expect(run).toMatchObject({ id, wallet: WALLET, source: "sandbox", traceStored: true });
    expect(run?.result).toEqual(simulationResult({ runId: id })); // u64 strings past 2^53 survive
  });

  it("any allowlisted session reads any run (the route checks the session); unknown ids are not found", async () => {
    const id = await store.create({ wallet: WALLET, engine: "rpc", input: "AQID", overrides: [], result: simulationResult({ engine: "rpc" }) });
    expect((await store.get(id))?.wallet).toBe(WALLET);
    expect(await store.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await store.get("not-a-uuid")).toBeNull();
  });

  it("stores the streamer's re-runs with their best-effort label", async () => {
    const replay = { signature: SIG, slot: 1, onChainError: null, onChainTxError: null, accuracy: "best-effort" as const, outcomeMatches: true };
    const id = await store.create({ wallet: WALLET, engine: "local", source: "stream", input: "AQID", overrides: [], result: simulationResult({ replay }) });
    expect(await store.get(id)).toMatchObject({ source: "stream", result: { replay } });
  });

  it("reads runs stored before traces and replay labels existed, with placeholders", async () => {
    const legacy: Record<string, unknown> = { ...simulationResult() };
    delete legacy.trace;
    delete legacy.accountDiffs;
    delete legacy.replay;
    const id = "4b1f3a5e-9c2d-4e8f-a1b2-3c4d5e6f7a8b";
    await db.insert(runs).values({ id, wallet: WALLET, engine: "local", input: "AQID", overrides: [], result: legacy });
    const run = await store.get(id);
    expect(run).toMatchObject({ traceStored: false, source: "sandbox" });
    expect(run?.result).toMatchObject({ trace: { nodes: [], complete: false }, accountDiffs: [], replay: null, runId: id });
  });

  it("refuses a stored row that no longer fits the contract, instead of returning it", async () => {
    const id = "5b1f3a5e-9c2d-4e8f-a1b2-3c4d5e6f7a8b";
    await db.insert(runs).values({ id, wallet: WALLET, engine: "local", input: "AQID", overrides: [], result: { ok: true } });
    await expect(store.get(id)).rejects.toThrow(UnreadableRunError);
  });

  it("stores program text Postgres would reject (U+0000, lone surrogates) with U+FFFD in its place", async () => {
    const result = simulationResult({ logs: ["Program log: a\u0000b", "Program log: \ud800"] });
    const id = await store.create({ wallet: WALLET, engine: "local", input: "AQID", overrides: [], result });
    expect((await store.get(id))?.result.logs).toEqual(["Program log: a�b", "Program log: �"]);
  });

  it("gives every run a different id", async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => store.create({ wallet: WALLET, engine: "rpc", input: "AQID", overrides: [], result: simulationResult({ engine: "rpc" }) })),
    );
    expect(new Set(ids).size).toBe(20);
  });
});
