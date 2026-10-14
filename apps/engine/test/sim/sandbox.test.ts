import type { SimulationResult } from "@soltracer/shared/simulation";
import { describe, expect, it } from "vitest";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import type { RpcSession } from "../../src/rpc/client.ts";
import type { NewRun, RunStore } from "../../src/runs/run-store.ts";
import type { SimulateOutcome } from "../../src/sim/common.ts";
import { createProgramCache, LocalLoadError } from "../../src/sim/local/loader.ts";
import { runSandbox } from "../../src/sim/sandbox.ts";

const WALLET = "AddressLookupTab1e1111111111111111111111111";
const RUN_ID = "3f0a9a6e-6c1f-4f61-9d2b-5d1b8f3e2a10";
const result = (engine: "rpc" | "local") => ({ ok: true, engine, fallbackReason: null, runId: null }) as unknown as SimulationResult;

function deps(engines: { local?: () => Promise<SimulateOutcome>; rpc?: () => Promise<SimulateOutcome> }) {
  const stored: NewRun[] = [];
  const runs: RunStore = {
    create: async (run) => {
      stored.push(run);
      return RUN_ID;
    },
    get: async () => null,
  };
  const never = async (): Promise<SimulateOutcome> => {
    throw new Error("engine should not run");
  };
  return {
    stored,
    deps: {
      session: { rpc: undefined as never, credits: () => 0 } satisfies RpcSession,
      caches: createMemoryCaches(),
      programCache: createProgramCache(),
      runs,
      engines: { local: engines.local ?? never, rpc: engines.rpc ?? never },
    },
  };
}

describe("runSandbox", () => {
  it("runs locally by default and stores the run under the session wallet", async () => {
    const { deps: d, stored } = deps({ local: async () => ({ ok: true, result: result("local") }) });
    const out = await runSandbox({ tx: "AQID", engine: "local", overrides: [] }, WALLET, d);
    expect(out).toMatchObject({ ok: true, result: { engine: "local", runId: RUN_ID } });
    expect(stored).toEqual([{ wallet: WALLET, engine: "local", input: "AQID", overrides: [], result: result("local") }]);
  });

  it("falls back to rpc with the reason when local state can't be loaded", async () => {
    const { deps: d } = deps({
      local: async () => {
        throw new LocalLoadError("Program X uses an unsupported loader");
      },
      rpc: async () => ({ ok: true, result: result("rpc") }),
    });
    const out = await runSandbox({ tx: "AQID", engine: "local", overrides: [] }, WALLET, d);
    expect(out).toMatchObject({ ok: true, result: { engine: "rpc", fallbackReason: "Program X uses an unsupported loader" } });
  });

  it("refuses instead of falling back when the run has overrides", async () => {
    const { deps: d, stored } = deps({
      local: async () => {
        throw new LocalLoadError("could not load");
      },
    });
    const out = await runSandbox(
      { tx: "AQID", engine: "local", overrides: [{ kind: "sol", address: WALLET, lamports: "1" }] },
      WALLET,
      d,
    );
    expect(out).toMatchObject({ ok: false, status: 422, error: { code: "LOCAL_LOAD_FAILED" } });
    expect(stored).toEqual([]);
  });

  it("still returns the result, without a run id, if storing the run fails", async () => {
    const { deps: d } = deps({ local: async () => ({ ok: true, result: result("local") }) });
    d.runs.create = async () => {
      throw new Error("db down");
    };
    expect(await runSandbox({ tx: "AQID", engine: "local", overrides: [] }, WALLET, d)).toMatchObject({ ok: true, result: { runId: null } });
  });

  it("uses rpc directly when asked, does not store failed runs, and lets other errors through", async () => {
    const failing = deps({ rpc: async () => ({ ok: false, status: 400, error: { ok: false, code: "TX_DECODE_FAILED", message: "x", details: null } }) });
    expect(await runSandbox({ tx: "AQID", engine: "rpc", overrides: [] }, WALLET, failing.deps)).toMatchObject({ ok: false });
    expect(failing.stored).toEqual([]);

    const crashing = deps({
      local: async () => {
        throw new TypeError("bug");
      },
    });
    await expect(runSandbox({ tx: "AQID", engine: "local", overrides: [] }, WALLET, crashing.deps)).rejects.toThrow(TypeError);
  });
});
