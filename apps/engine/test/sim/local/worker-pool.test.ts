import { describe, expect, it, vi } from "vitest";
import { createWorkerPool, LOCAL_RUNNER_WORKER } from "../../../src/sim/local/worker-pool.ts";
import { LocalLoadError } from "../../../src/sim/local/loader.ts";
import { runLocal } from "../../../src/sim/local/runner.ts";
import { loadComparison } from "../../helpers/replay.ts";
import { decodeTransactionInput } from "../../../src/tx/decode.ts";
import { resolveAccounts } from "../../../src/tx/lookup-tables.ts";
import { createProgramCache, loadState } from "../../../src/sim/local/loader.ts";
import { createReplayTransport } from "../../../src/rpc/replay.ts";
import { createRpcClient } from "../../../src/rpc/client.ts";
import { createRateLimiter } from "../../../src/rpc/rate-limiter.ts";
import type { Address } from "@solana/kit";
import { createMemoryCaches } from "../../../src/cache/memory.ts";
import { loadTables } from "../../../src/sim/common.ts";

const worker = (name: string) => new URL(`../../fixtures/workers/${name}.mjs`, import.meta.url);

describe("createWorkerPool", () => {
  it("runs jobs on workers and returns their output", async () => {
    const pool = createWorkerPool<string, { echoed: string }>({ size: 2, timeoutMs: 1000, workerUrl: worker("echo") });
    try {
      expect(await Promise.all(["a", "b", "c"].map((x) => pool.run(x)))).toEqual([{ echoed: "a" }, { echoed: "b" }, { echoed: "c" }]);
    } finally {
      await pool.close();
    }
  });

  it("times a stuck run out without blocking the event loop, then serves the next job", async () => {
    const pool = createWorkerPool<string, unknown>({ size: 1, timeoutMs: 150, workerUrl: worker("busy") });
    try {
      let ticks = 0;
      const timer = setInterval(() => (ticks += 1), 10);
      const started = Date.now();
      await expect(pool.run("x")).rejects.toThrow(LocalLoadError);
      clearInterval(timer);
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      expect(ticks).toBeGreaterThan(5); // the main thread kept running while the worker spun
      await expect(pool.run("y")).rejects.toThrow(/timed out/); // a fresh worker took its place
    } finally {
      await pool.close();
    }
  });

  it("replaces a crashed worker and reports the failure as a local load error", async () => {
    const pool = createWorkerPool<string, unknown>({ size: 1, timeoutMs: 1000, workerUrl: worker("crash") });
    try {
      await expect(pool.run("x")).rejects.toThrow(LocalLoadError);
      await expect(pool.run("y")).rejects.toThrow(LocalLoadError);
    } finally {
      await pool.close();
    }
  });
});

describe("pool lifecycle", () => {
  it("close() rejects queued and running jobs and nothing respawns afterwards", async () => {
    const pool = createWorkerPool<string, unknown>({ size: 1, timeoutMs: 10_000, workerUrl: worker("busy") });
    // Attach the assertions before close() rejects, so neither rejection is ever unhandled.
    const running = expect(pool.run("a")).rejects.toThrow(/shut down/);
    const queued = expect(pool.run("b")).rejects.toThrow(/shut down/);
    await new Promise((r) => setTimeout(r, 20));
    await pool.close();
    await running;
    await queued;
    await expect(pool.run("c")).rejects.toThrow(/shut down/);
  });

  it("stops respawning after repeated failures and fails fast", async () => {
    const pool = createWorkerPool<string, unknown>({ size: 1, timeoutMs: 1000, workerUrl: worker("crash") });
    try {
      for (let i = 0; i < 5; i++) await expect(pool.run(String(i))).rejects.toThrow(LocalLoadError);
      const started = Date.now();
      await expect(pool.run("again")).rejects.toThrow(/keeps failing/);
      expect(Date.now() - started).toBeLessThan(50);
    } finally {
      await pool.close();
    }
  });
});

describe("hostile runs can't take the runner down (audit L1)", () => {
  it("repeated timeouts replace the worker but never break the pool", async () => {
    // 250 ms also covers the replacement worker's startup before the final job.
    const pool = createWorkerPool<string, unknown>({ size: 1, timeoutMs: 250, workerUrl: worker("selective") });
    try {
      for (let i = 0; i < 6; i++) await expect(pool.run("spin")).rejects.toThrow(/timed out/);
      expect(await pool.run("ok")).toEqual({ echoed: "ok" });
    } finally {
      await pool.close();
    }
  });

  it("a broken pool tries again after its cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pool = createWorkerPool<string, unknown>({ size: 1, timeoutMs: 1000, workerUrl: worker("crash"), cooldownMs: 60_000 });
    try {
      for (let i = 0; i < 5; i++) await expect(pool.run(String(i))).rejects.toThrow(LocalLoadError);
      await expect(pool.run("again")).rejects.toThrow(/keeps failing/);
      vi.setSystemTime(Date.now() + 60_001);
      // A fresh worker is spawned and gets the job (this one crashes too, so the error is a crash, not "keeps failing").
      await expect(pool.run("after cooldown")).rejects.toThrow(/crashed|exited/);
    } finally {
      vi.useRealTimers();
      await pool.close();
    }
  });

  it("refuses work past the queue cap instead of queueing without bound", async () => {
    const pool = createWorkerPool<string, unknown>({ size: 1, timeoutMs: 10_000, workerUrl: worker("busy"), maxQueue: 2 });
    const pending = [pool.run("a"), pool.run("b"), pool.run("c")].map((p) => expect(p).rejects.toThrow(/shut down/));
    try {
      await expect(pool.run("d")).rejects.toThrow(/busy/);
    } finally {
      await pool.close();
      await Promise.all(pending);
    }
  });
});

describe("LiteSVM in a worker", () => {
  it("gives exactly the same result as running in-thread (Jupiter swap)", async () => {
    const rec = loadComparison("jupiter-swap-fresh");
    const decoded = decodeTransactionInput(rec.input);
    if (!decoded.ok) throw new Error(decoded.error.message);
    const session = createRpcClient({
      url: "https://replay.invalid",
      limiter: createRateLimiter({ limit: 1000, windowMs: 1000 }),
      transport: createReplayTransport(rec.local),
      log: { info: () => undefined, warn: () => undefined },
    }).session();
    // The same loading sequence as simulateLocally.
    const tables = await loadTables(session, createMemoryCaches(), decoded.tx.lookups);
    const accounts = resolveAccounts(decoded.tx, tables);
    const keys = [...new Set([...accounts.map((a) => a.address as Address), ...decoded.tx.lookups.map((l) => l.table)])];
    const state = await loadState(keys, session, createProgramCache());
    const input = { wire: new Uint8Array(Buffer.from(decoded.tx.wireBase64, "base64")), accounts: state.accounts, programs: state.programs, clock: state.clock };

    const pool = createWorkerPool({ size: 1, timeoutMs: 10_000, workerUrl: LOCAL_RUNNER_WORKER });
    try {
      const viaWorker = await pool.run(input);
      expect(viaWorker).toEqual(runLocal(input));
    } finally {
      await pool.close();
    }
  });
});
