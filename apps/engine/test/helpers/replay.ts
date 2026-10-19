import { readFileSync } from "node:fs";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import { createRpcClient, type RpcCallRecord } from "../../src/rpc/client.ts";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";
import type { Override } from "@soltracer/shared/simulation";
import type { RpcTransport } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { createReplayTransport, parseRecordedJson, resolveBlobs } from "../../src/rpc/replay.ts";
import type { RateLimiter } from "../../src/rpc/rate-limiter.ts";
import { createProgramCache } from "../../src/sim/local/loader.ts";
import { simulateLocally } from "../../src/sim/local/local-simulator.ts";
import { optimizeWithRpc } from "../../src/optimize/optimizer.ts";
import { simulateWithRpc } from "../../src/sim/rpc-simulator.ts";
import type { SandboxFixtureName } from "./sandbox-fixtures.ts";

export function loadSimRecording(name: SandboxFixtureName): { input: string; rpc: RpcCallRecord[] } {
  return loadRecording(`${name}.sim.json`);
}

function loadRecording(file: string): { input: string; rpc: RpcCallRecord[] } {
  const text = readFileSync(new URL(`../fixtures/sandbox/${file}`, import.meta.url), "utf8");
  return parseRecordedJson(text) as { input: string; rpc: RpcCallRecord[] };
}

/** Runs the real optimizer (p75, cold caches) against recorded Helius responses. */
export async function replayOptimization(name: string) {
  const recording = loadRecording(`${name}.opt.json`);
  const transport = createReplayTransport(recording.rpc);
  const client = createRpcClient({
    url: "https://replay.invalid",
    limiter: createRateLimiter({ limit: 1000, windowMs: 1000 }),
    transport,
    log: { info: () => undefined, warn: () => undefined },
  });
  const outcome = await optimizeWithRpc({ tx: recording.input, preset: "p75" }, client.session(), createMemoryCaches());
  return { outcome, unused: transport.unused(), input: recording.input };
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

const BLOB_DIR = fileURLToPath(new URL("../fixtures/blobs", import.meta.url));

export const COMPARISON_FIXTURES = [
  "sol-transfer",
  "jupiter-swap-alt",
  "jupiter-swap-fresh",
  "jupiter-slippage-6001",
  "token-2022-transfer",
  "v1-transaction",
  "jupiter-usdc-input",
] as const;
export type ComparisonName = (typeof COMPARISON_FIXTURES)[number];

/** A back-to-back rpc + local recording (scripts/fixtures.ts compare), with blobs inflated. */
export function loadComparison(name: ComparisonName): { input: string; rpc: RpcCallRecord[]; local: RpcCallRecord[] } {
  const text = readFileSync(new URL(`../fixtures/sandbox/${name}.cmp.json`, import.meta.url), "utf8");
  return resolveBlobs(parseRecordedJson(text), BLOB_DIR) as { input: string; rpc: RpcCallRecord[]; local: RpcCallRecord[] };
}

function replayClient(transport: RpcTransport, limiter?: RateLimiter) {
  return createRpcClient({
    url: "https://replay.invalid",
    limiter: limiter ?? createRateLimiter({ limit: 1000, windowMs: 1000 }),
    transport,
    log: { info: () => undefined, warn: () => undefined },
  });
}

/** Replays one engine of a comparison recording. */
export async function replayEngine(
  name: ComparisonName,
  engine: "rpc" | "local",
  options: {
    overrides?: Override[];
    limiter?: RateLimiter;
    onCall?: () => void;
    /** Answer unrecorded getAccountInfo (IDL lookups for errors the recording never hit) with "no account". */
    unrecordedAccountsMissing?: boolean;
  } = {},
) {
  const recording = loadComparison(name);
  const replay = createReplayTransport(engine === "rpc" ? recording.rpc : recording.local);
  const transport = (async (config: Parameters<RpcTransport>[0]) => {
    options.onCall?.();
    try {
      return await replay(config);
    } catch (err) {
      const payload = config.payload as { method?: string; id?: unknown };
      if (options.unrecordedAccountsMissing && payload.method === "getAccountInfo") {
        return { jsonrpc: "2.0", id: payload.id, result: { context: { slot: 0n }, value: null } };
      }
      throw err;
    }
  }) as RpcTransport;
  const session = replayClient(transport, options.limiter).session();
  const outcome =
    engine === "rpc"
      ? await simulateWithRpc(recording.input, session, createMemoryCaches())
      : await simulateLocally(recording.input, options.overrides ?? [], session, createMemoryCaches(), createProgramCache());
  return { outcome, unused: replay.unused() };
}
