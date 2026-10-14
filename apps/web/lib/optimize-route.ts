import { optimizeRequestSchema, optimizeResultSchema, type OptimizeResult } from "@soltracer/shared/optimize";
import type { EngineResult } from "./engine-client.ts";
import { proxyToEngine, type EngineRouteInput } from "./engine-route.ts";

/** Optimize runs up to three simulations plus fee and blockhash reads at 10 req/s; allow for a cold cache. */
export const OPTIMIZE_TIMEOUT_MS = 30_000;

/** Server-side logic for POST /api/optimize. Never retried: each call spends ~8–10 Helius credits. */
export function handleOptimize(input: EngineRouteInput): Promise<EngineResult<OptimizeResult>> {
  return proxyToEngine(
    { path: "/optimize", request: optimizeRequestSchema, response: optimizeResultSchema, timeoutMs: OPTIMIZE_TIMEOUT_MS },
    input,
  );
}
