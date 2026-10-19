import { txStatusRequestSchema, txStatusResultSchema, type TxStatusResult } from "@soltracer/shared/optimize";
import type { EngineResult } from "./engine-client.ts";
import { proxyToEngine, type EngineRouteInput } from "./engine-route.ts";

/** Server-side logic for POST /api/tx-status: one status lookup per call, no polling. */
export function handleTxStatus(input: EngineRouteInput): Promise<EngineResult<TxStatusResult>> {
  return proxyToEngine({ path: "/tx-status", request: txStatusRequestSchema, response: txStatusResultSchema }, input);
}
