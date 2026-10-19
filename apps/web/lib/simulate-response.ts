import type { ErrorResponse } from "@soltracer/shared/errors";
import { simulationResultSchema, type SimulationResult } from "@soltracer/shared/simulation";
import { parseApiResponse, postApi } from "./api-response.ts";

export type SimulateOutcome = SimulationResult | ErrorResponse;

/** Validates a `/api/simulate` reply; see `parseApiResponse`. */
export function parseSimulateResponse(httpOk: boolean, json: unknown): SimulateOutcome {
  return parseApiResponse(simulationResultSchema, httpOk, json);
}

/** Posts the transaction to this app's API. Network failures become a typed error, never a throw. */
export function postSimulate(tx: string, fetchImpl: typeof fetch = fetch): Promise<SimulateOutcome> {
  return postApi("/api/simulate", { tx }, simulationResultSchema, fetchImpl);
}
