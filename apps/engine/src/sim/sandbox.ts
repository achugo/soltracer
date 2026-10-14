import { makeError } from "@soltracer/shared/errors";
import type { SimulateRequest } from "@soltracer/shared/simulation";
import type { SandboxCaches } from "../cache/types.ts";
import type { RpcSession } from "../rpc/client.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { SimulateOutcome, SimulatorLog } from "./common.ts";
import { LocalLoadError, type ProgramCache } from "./local/loader.ts";
import { simulateLocally } from "./local/local-simulator.ts";
import { simulateWithRpc } from "./rpc-simulator.ts";

export interface SandboxDeps {
  session: RpcSession;
  caches: SandboxCaches;
  programCache: ProgramCache;
  runs: RunStore;
  log?: SimulatorLog;
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
    outcome = await rpc(request.tx, session, caches, log);
  } else {
    try {
      outcome = await local(request.tx, request.overrides, session, caches, programCache, log);
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
      outcome = await rpc(request.tx, session, caches, log);
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
      result: outcome.result,
    });
    return { ok: true, result: { ...outcome.result, runId } };
  } catch (err) {
    // The simulation itself succeeded; losing the record must not lose the answer.
    log?.info({ err: err instanceof Error ? err.message : String(err) }, "run not stored");
    return outcome;
  }
}
