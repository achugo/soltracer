import { readFileSync } from "node:fs";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import { createRpcClient, type RpcCallRecord } from "../../src/rpc/client.ts";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";
import { createReplayTransport, parseRecordedJson } from "../../src/rpc/replay.ts";
import { simulateWithRpc } from "../../src/sim/rpc-simulator.ts";
import type { SandboxFixtureName } from "./sandbox-fixtures.ts";

export function loadSimRecording(name: SandboxFixtureName): { input: string; rpc: RpcCallRecord[] } {
  const text = readFileSync(new URL(`../fixtures/sandbox/${name}.sim.json`, import.meta.url), "utf8");
  return parseRecordedJson(text) as { input: string; rpc: RpcCallRecord[] };
}

/** Runs the real simulator against recorded Helius responses (no network). */
export async function replaySimulation(
  name: SandboxFixtureName,
  caches = createMemoryCaches(),
  edit: (records: RpcCallRecord[]) => RpcCallRecord[] = (r) => r,
) {
  const loaded = loadSimRecording(name);
  const recording = { ...loaded, rpc: edit(loaded.rpc) };
  const transport = createReplayTransport(recording.rpc);
  const client = createRpcClient({
    url: "https://replay.invalid",
    limiter: createRateLimiter({ limit: 1000, windowMs: 1000 }),
    transport,
    log: { info: () => undefined, warn: () => undefined },
  });
  const outcome = await simulateWithRpc(recording.input, client.session(), caches);
  return { outcome, unused: transport.unused(), caches, recording };
}
