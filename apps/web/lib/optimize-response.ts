import type { ErrorResponse } from "@soltracer/shared/errors";
import {
  optimizeResultSchema,
  txStatusResultSchema,
  type FeePreset,
  type OptimizeResult,
  type TxStatusResult,
} from "@soltracer/shared/optimize";
import { parseApiResponse, postApi } from "./api-response.ts";

export type OptimizeOutcome = OptimizeResult | ErrorResponse;
export type TxStatusOutcome = TxStatusResult | ErrorResponse;

export function parseOptimizeResponse(httpOk: boolean, json: unknown): OptimizeOutcome {
  return parseApiResponse(optimizeResultSchema, httpOk, json);
}

/** One optimize request. Callers must never retry it automatically: it spends Helius credits. */
export function postOptimize(tx: string, preset: FeePreset, fetchImpl: typeof fetch = fetch): Promise<OptimizeOutcome> {
  return postApi("/api/optimize", { tx, preset }, optimizeResultSchema, fetchImpl);
}

export function parseTxStatusResponse(httpOk: boolean, json: unknown): TxStatusOutcome {
  return parseApiResponse(txStatusResultSchema, httpOk, json);
}

export function postTxStatus(signature: string, fetchImpl: typeof fetch = fetch): Promise<TxStatusOutcome> {
  return postApi("/api/tx-status", { signature }, txStatusResultSchema, fetchImpl);
}
