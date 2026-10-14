import { makeError } from "@soltracer/shared/errors";
import type { SimulateRequest } from "@soltracer/shared/simulation";
import type { SandboxCaches } from "../cache/types.ts";
import type { RpcSession } from "../rpc/client.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { IdlMode, SimulateOutcome, SimulatorLog } from "./common.ts";
import { LocalLoadError, type ProgramCache } from "./local/loader.ts";
import { simulateLocally } from "./local/local-simulator.ts";
import { simulateWithRpc } from "./rpc-simulator.ts";

/** At most this many local runs at once: each holds programs in memory and blocks while executing. */
export const MAX_CONCURRENT_LOCAL_RUNS = 2;
let activeLocalRuns = 0;
const waitingLocalRuns: (() => void)[] = [];

async function withLocalSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeLocalRuns < MAX_CONCURRENT_LOCAL_RUNS) activeLocalRuns += 1;
  else await new Promise<void>((resolve) => waitingLocalRuns.push(resolve)); // the slot is handed over
  try {
    return await run();
  } finally {
    // Hand the slot straight to the next waiter (FIFO) so a new caller can't slip in between.
    const next = waitingLocalRuns.shift();
    if (next) next();
    else activeLocalRuns -= 1;
  }
}

export interface SandboxDeps {
  session: RpcSession;
  caches: SandboxCaches;
  programCache: ProgramCache;
  runs: RunStore;
  log?: SimulatorLog;
  /** Read IDLs to decode traces ("fetch", production) or use only cached ones (default, tests). */
  idlMode?: IdlMode;
  /** Runs LiteSVM (the worker pool in production). */
  localRunner?: Parameters<typeof simulateLocally>[6];
  /** Engines; injectable for tests. */
  engines?: { local: typeof simulateLocally; rpc: typeof simulateWithRpc };
}

/**
 * One Sandbox run. Local by default; if local state can't be loaded it falls back to rpc with
 * the reason, unless the run has overrides (rpc can't apply them, so that would answer a
 * different question). Every completed run is stored under the session wallet.
 */
export async function runSandbox(request: SimulateRequest, wallet: string, deps: SandboxDeps): Promise<SimulateOutcome> {
  const { session, caches, programCache, log } = deps;
  const { local, rpc } = deps.engines ?? { local: simulateLocally, rpc: simulateWithRpc };
  let outcome: SimulateOutcome;
  if (request.engine === "rpc") {
    outcome = await rpc(request.tx, session, caches, log, deps.idlMode);
  } else {
    try {
      outcome = await withLocalSlot(() =>
        local(request.tx, request.overrides, session, caches, programCache, log, deps.localRunner, deps.idlMode),
      );
    } catch (err) {
      if (!(err instanceof LocalLoadError)) throw err;
      if (request.overrides.length > 0) {
        return {
          ok: false,
          status: 422,
          error: makeError("LOCAL_LOAD_FAILED", `Can't run locally, so the overrides can't be applied: ${err.message}`),
        };
      }
      log?.info({ reason: err.message }, "local run fell back to rpc");
      outcome = await rpc(request.tx, session, caches, log, deps.idlMode);
      if (outcome.ok) outcome = { ok: true, result: { ...outcome.result, fallbackReason: err.message } };
    }
  }
  if (!outcome.ok) return outcome;
  try {
    const runId = await deps.runs.create({
      wallet,
      engine: outcome.result.engine,
      input: request.tx,
      overrides: request.overrides,
      // Raw override data is kept once, in `overrides`; the result's echo drops it.
      result: {
        ...outcome.result,
        overrides: outcome.result.overrides.map((o) => (o.kind === "data" ? { ...o, dataBase64: "" } : o)),
      },
    });
    return { ok: true, result: { ...outcome.result, runId } };
  } catch (err) {
    // The simulation itself succeeded; losing the record must not lose the answer.
    // Don't log the error message: drizzle's includes the full query and its parameters (the run itself).
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    log?.info({ dbCode: typeof code === "string" ? code : null }, "run not stored");
    return outcome;
  }
}
